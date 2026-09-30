import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { D1ApiAdapter } from "@saas/db/runner";
import { route as ledgerRoute } from "@ledger-worker/router";
import type { Env as LedgerEnv } from "@ledger-worker/env";
import { route as proxyRoute } from "@proxy-worker/index";
import type { Env as ProxyEnv } from "@proxy-worker/env";
import { clearActorCache } from "@proxy-worker/auth";
import { handle as mockUpstream } from "@mock-upstream/index";

// The proxy under test, wired the way stage wires it: identity resolves the
// Meterwise key, the REAL ledger-worker router over a real SQLite database
// answers the check and stores the events, and the stage mock upstream's own
// code stands in for the provider. No test here calls a real provider.

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(__dirname, "../../..");
const MIGRATIONS_ROOT = join(REPO, "packages/db/src/migrations");

/** An obviously fake provider key (the repo is public), and a distinctive piece of it. */
export const FAKE_KEY = "sk-test-not-a-real-key-mw3-custody-7c1f9e2d4b";
export const FAKE_KEY_PIECE = "custody-7c1f9e2d";
/** The Meterwise API key (x-meterwise-key) of ORG_A's builder service principal. */
export const MW_KEY = "sk_mwtest_0123456789abcdef";
export const MW_KEY_OTHER_ORG = "sk_mwtest_fedcba9876543210";

export const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const ORG_A_PUBLIC = `org_${ORG_A.replace(/-/g, "")}`;
export const OWNER = "11111111-1111-4111-8111-111111111111";
export const KEY_A = "sp_0123456789abcdef0123456789abcdef";
export const KEY_B = "sp_fedcba9876543210fedcba9876543210";

export function migratedDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dirs = readdirSync(MIGRATIONS_ROOT)
    .filter((d) => existsSync(join(MIGRATIONS_ROOT, d, "up.sql")))
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(join(MIGRATIONS_ROOT, dir, "up.sql"), "utf8");
    for (const statement of D1ApiAdapter.splitStatements(sql)) db.exec(statement);
  }
  return db;
}

function d1Over(db: DatabaseSync): D1Database {
  return {
    prepare(query: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        all<T>() {
          const rows = db.prepare(query).all(...(bound as never[])) as T[];
          return Promise.resolve({ results: rows, success: true, meta: {} });
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

const MEMBERSHIPS: Record<string, Record<string, string>> = {
  [OWNER]: { [ORG_A]: "owner" },
  [KEY_A]: { [ORG_A]: "builder" },
  [KEY_B]: { [ORG_B]: "builder" },
};
const ROLE_ACTIONS: Record<string, ReadonlySet<string>> = {
  owner: new Set(["ledger.read", "ledger.ingest", "ledger.budget.write"]),
  builder: new Set(["ledger.read", "ledger.ingest"]),
};

function fleet(): Pick<LedgerEnv, "MEMBERSHIP_WORKER" | "POLICY_WORKER"> {
  const membership = {
    async fetch(_url: string, init: RequestInit) {
      const body = JSON.parse(String(init.body)) as { subject: { id: string }; orgId: string };
      const role = MEMBERSHIPS[body.subject.id]?.[body.orgId] ?? null;
      return Response.json({ data: { memberships: role ? [{ kind: "organization", orgId: body.orgId, role }] : [] } });
    },
  };
  const policy = {
    async fetch(_url: string, init: RequestInit) {
      const body = JSON.parse(String(init.body)) as { action: string; resource: { orgId: string }; context: { memberships: { orgId: string; role: string }[] } };
      const role = body.context.memberships.find((m) => m.orgId === body.resource.orgId)?.role;
      return Response.json({ data: { allow: role !== undefined && (ROLE_ACTIONS[role]?.has(body.action) ?? false) } });
    },
  };
  return { MEMBERSHIP_WORKER: membership as unknown as Fetcher, POLICY_WORKER: policy as unknown as Fetcher };
}

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

async function record(input: RequestInfo | URL, init?: RequestInit): Promise<{ request: Request; rec: Recorded }> {
  const request = input instanceof Request && !init ? input : new Request(input as string, init);
  const body = await request.clone().text();
  return { request, rec: { url: request.url, method: request.method, headers: Object.fromEntries(request.headers.entries()), body } };
}

export type UpstreamMode = "mock" | "unreachable" | "hang";

export interface ProxyWorld {
  db: DatabaseSync;
  ledgerEnv: LedgerEnv;
  env: ProxyEnv;
  /** Every request the proxy sent to ledger-worker. */
  ledgerCalls: Recorded[];
  /** Every request the proxy sent upstream. */
  upstreamCalls: Recorded[];
  identityCalls: Recorded[];
  mode: UpstreamMode;
  /** Resolves when the upstream has been called (for the timeout test). */
  upstreamCalled: Promise<void>;
  /** Run the proxy and settle everything it handed to waitUntil. */
  call(path: string, init?: RequestInit): Promise<{ res: Response; body: string }>;
  /** Start a call without reading the body or settling waitUntil. */
  start(path: string, init?: RequestInit): { res: Promise<Response>; settle: () => Promise<void> };
}

export function proxyWorld(): ProxyWorld {
  clearActorCache();
  const db = migratedDatabase();
  const ledgerEnv = { ENVIRONMENT: "test", PLATFORM_DB: d1Over(db), ...fleet() } as LedgerEnv;
  let markCalled: () => void = () => undefined;
  const w: ProxyWorld = {
    db,
    ledgerEnv,
    ledgerCalls: [],
    upstreamCalls: [],
    identityCalls: [],
    mode: "mock",
    upstreamCalled: new Promise<void>((r) => (markCalled = r)),
    env: {} as ProxyEnv,
    async call(path, init = {}) {
      const s = w.start(path, init);
      const res = await s.res;
      const body = await res.text();
      await s.settle();
      return { res, body };
    },
    start(path, init = {}) {
      const pending: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
      const res = proxyRoute(new Request(`https://meterwise-proxy-worker-test.example${path}`, init), w.env, ctx);
      return {
        res,
        settle: async () => {
          await res;
          await Promise.all(pending);
        },
      };
    },
  };
  w.env = {
    ENVIRONMENT: "test",
    IDENTITY_WORKER: {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const { request, rec } = await record(input, init);
        w.identityCalls.push(rec);
        const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        const who = token === MW_KEY ? { sp: KEY_A, org: ORG_A } : token === MW_KEY_OTHER_ORG ? { sp: KEY_B, org: ORG_B } : null;
        if (!who) return Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
        return Response.json({ data: { actor: { actorType: "service_principal", actorId: who.sp, orgId: who.org } } });
      },
    } as unknown as Fetcher,
    LEDGER_WORKER: {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const { request, rec } = await record(input, init);
        w.ledgerCalls.push(rec);
        return ledgerRoute(request, ledgerEnv);
      },
    } as unknown as Fetcher,
    UPSTREAM_OVERRIDE: {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const { request, rec } = await record(input, init);
        w.upstreamCalls.push(rec);
        markCalled();
        if (w.mode === "unreachable") throw new TypeError(`connect ECONNREFUSED while sending ${rec.headers.authorization ?? ""}`);
        if (w.mode === "hang") {
          return new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(new DOMException(`aborted ${rec.headers.authorization ?? ""}`, "AbortError")));
          });
        }
        return mockUpstream(request);
      },
    } as unknown as Fetcher,
  };
  return w;
}

/** A chat-completions request as the OpenAI SDK sends it through the proxy. */
export function chat(over: Record<string, unknown> = {}, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${FAKE_KEY}`,
      "content-type": "application/json",
      "x-meterwise-key": MW_KEY,
      "x-meterwise-tenant": "acme",
      "x-meterwise-feature": "support-bot",
      "x-meterwise-user": "u-7",
      "openai-organization": "org-test-not-real",
      cookie: "session=not-for-openai",
      ...headers,
    },
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hello" }], ...over }),
  };
}

/** Every row of every table in the database, as one string. */
export function dumpDatabase(db: DatabaseSync): string {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  return tables.map((t) => `${t}:${JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())}`).join("\n");
}
