/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route as ledgerRoute } from "@ledger-worker/router";
import {
  FAKE_KEY,
  FAKE_KEY_PIECE,
  MW_KEY,
  KEY_A,
  ORG_A_PUBLIC,
  OWNER,
  REPO,
  chat,
  dumpDatabase,
  proxyWorld,
  type ProxyWorld,
} from "./harness";

// Design §7.6: the seven tests the proxy must carry, all against the mock
// upstream (the stage mock's own code) and the real ledger over SQLite.

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

function contains(haystack: string, ...needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/** Run every kind of call the proxy handles, capturing console output throughout. */
async function exerciseEverything(w: ProxyWorld): Promise<{ bodies: Record<string, { status: number; body: string }>; logs: string[] }> {
  const logs: string[] = [];
  const original = Object.fromEntries(CONSOLE_METHODS.map((m) => [m, console[m]]));
  for (const m of CONSOLE_METHODS) console[m] = (...args: unknown[]) => void logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" "));
  const realSetTimeout = globalThis.setTimeout;
  const bodies: Record<string, { status: number; body: string }> = {};
  const run = async (name: string, path: string, init: RequestInit): Promise<void> => {
    const { res, body } = await w.call(path, init);
    bodies[name] = { status: res.status, body };
  };
  try {
    await run("streamed", "/v1/chat/completions", chat({ stream: true }));
    await run("non-streamed", "/v1/chat/completions", chat());
    await run("upstream 401", "/v1/chat/completions", chat({ model: "mock-error-401" }));
    await run("upstream 500", "/v1/chat/completions", chat({ model: "mock-error-500" }));
    await run("stream cut short", "/v1/chat/completions", chat({ model: "mock-disconnect", stream: true }));

    // Client abort: the caller reads one chunk and goes away.
    const aborted = w.start("/v1/chat/completions", chat({ stream: true }));
    const abortedRes = await aborted.res;
    const reader = abortedRes.body!.getReader();
    await reader.read();
    await reader.cancel();
    await aborted.settle();
    bodies["client abort"] = { status: abortedRes.status, body: "" };

    await run("400 no tenant", "/v1/chat/completions", chat({}, { "x-meterwise-tenant": "" }));
    await run("400 bad body", "/v1/chat/completions", { ...chat(), body: `{"model": "${FAKE_KEY}"` });
    await run("401 no key", "/v1/chat/completions", chat({}, { "x-meterwise-key": "" }));
    await run("401 provider key sent as the Meterwise key", "/v1/chat/completions", chat({}, { "x-meterwise-key": FAKE_KEY }));
    await run("400 provider key pasted as the model", "/v1/chat/completions", chat({ model: FAKE_KEY }));

    // 429: a hard budget already reached.
    await ledgerRoute(
      new Request(`https://ledger.internal/v1/organizations/${ORG_A_PUBLIC}/budgets/acme`, {
        method: "PUT",
        headers: { "x-actor-subject-id": OWNER, "x-actor-subject-type": "user", "content-type": "application/json" },
        body: JSON.stringify({ hardLimitNanoUsd: 1 }),
      }),
      w.ledgerEnv,
    );
    await run("429 budget", "/v1/chat/completions", chat());
    await ledgerRoute(
      new Request(`https://ledger.internal/v1/organizations/${ORG_A_PUBLIC}/budgets/acme`, {
        method: "DELETE",
        headers: { "x-actor-subject-id": OWNER, "x-actor-subject-type": "user" },
      }),
      w.ledgerEnv,
    );

    w.mode = "unreachable";
    await run("502 unreachable", "/v1/chat/completions", chat());
    w.mode = "hang";
    globalThis.setTimeout = ((fn: () => void, ms?: number) => realSetTimeout(fn, (ms ?? 0) >= 60_000 ? 5 : ms)) as typeof setTimeout;
    await run("504 timeout", "/v1/chat/completions", chat());
    w.mode = "mock";
  } finally {
    globalThis.setTimeout = realSetTimeout;
    for (const m of CONSOLE_METHODS) console[m] = original[m]!;
  }
  return { bodies, logs };
}

describe("design §7.6 — the provider key's custody", () => {
  let w: ProxyWorld;
  let bodies: Record<string, { status: number; body: string }>;
  let logs: string[];

  beforeAll(async () => {
    w = proxyWorld();
    ({ bodies, logs } = await exerciseEverything(w));
  });

  it("exercised every path it claims to", () => {
    expect(Object.fromEntries(Object.entries(bodies).map(([k, v]) => [k, v.status]))).toEqual({
      streamed: 200,
      "non-streamed": 200,
      "upstream 401": 401,
      "upstream 500": 500,
      "stream cut short": 200,
      "client abort": 200,
      "400 no tenant": 400,
      "400 bad body": 400,
      "401 no key": 401,
      "401 provider key sent as the Meterwise key": 401,
      "400 provider key pasted as the model": 400,
      "429 budget": 429,
      "502 unreachable": 502,
      "504 timeout": 504,
    });
  });

  it("1. the mock upstream receives the provider key byte-for-byte, and no x-meterwise-* header", () => {
    expect(w.upstreamCalls.length).toBeGreaterThanOrEqual(8);
    for (const call of w.upstreamCalls) {
      expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
      expect(call.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
      expect(Object.keys(call.headers).filter((h) => h.startsWith("x-meterwise"))).toEqual([]);
      expect(call.headers.cookie).toBeUndefined();
      expect(call.headers["openai-organization"]).toBe("org-test-not-real");
      expect(call.body).not.toContain(MW_KEY);
    }
  });

  it("2. no table of the ledger's SQLite database holds the key, after every kind of call", () => {
    const dump = dumpDatabase(w.db);
    expect(dump).toContain("ledger_events"); // the scan saw the tables…
    expect(dump).toContain('"source":"proxy"'); // …and the proxied rows in them
    expect(contains(dump, FAKE_KEY, FAKE_KEY_PIECE)).toBe(false);
  });

  it("3. nothing logged on any path contains the key or a distinctive piece of it", () => {
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect([line, contains(line, FAKE_KEY, FAKE_KEY_PIECE)]).toEqual([line, false]);
  });

  it("4. no response body Meterwise builds (400, 401, 429, 502, 504) contains the key", () => {
    for (const name of ["400 no tenant", "400 bad body", "400 provider key pasted as the model", "401 no key", "401 provider key sent as the Meterwise key", "429 budget", "502 unreachable", "504 timeout"]) {
      const { body } = bodies[name]!;
      expect([name, contains(body, FAKE_KEY, FAKE_KEY_PIECE)]).toEqual([name, false]);
      const err = JSON.parse(body).error;
      expect(Object.keys(err).sort()).toEqual(["code", "message", "requestId", "type"]);
    }
    expect(JSON.parse(bodies["429 budget"]!.body).error.code).toBe("budget_exceeded");
    expect(JSON.parse(bodies["502 unreachable"]!.body).error.code).toBe("upstream_unreachable");
    expect(JSON.parse(bodies["504 timeout"]!.body).error.code).toBe("upstream_timeout");
  });

  it("5. what proxy-worker sends to ledger-worker carries no authorization header and no field with the key", () => {
    expect(w.ledgerCalls.some((c) => c.url.includes("/proxy-events"))).toBe(true);
    expect(w.ledgerCalls.some((c) => c.url.endsWith("/llm-check"))).toBe(true);
    for (const call of w.ledgerCalls) {
      expect(call.headers.authorization).toBeUndefined();
      expect(contains(JSON.stringify(call.headers), FAKE_KEY, FAKE_KEY_PIECE, MW_KEY)).toBe(false);
      expect(contains(call.body, FAKE_KEY, FAKE_KEY_PIECE, MW_KEY)).toBe(false);
      expect(call.headers["x-actor-subject-id"]).toBe(KEY_A);
    }
    // identity-worker gets what the caller put in x-meterwise-key, as a bearer,
    // and never the Authorization header: the one call that carried the
    // provider key there is the call whose caller pasted it into x-meterwise-key.
    const bearers = w.identityCalls.map((c) => c.headers.authorization);
    expect(new Set(bearers)).toEqual(new Set([`Bearer ${MW_KEY}`, `Bearer ${FAKE_KEY}`]));
    expect(bearers.filter((b) => b === `Bearer ${FAKE_KEY}`)).toHaveLength(1);
  });

  it("6. the proxy-worker wrangler configuration has no d1_databases, kv_namespaces or r2_buckets", () => {
    const raw = readFileSync(join(REPO, "apps/proxy-worker/wrangler.template.jsonc"), "utf8");
    const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, "")) as Record<string, any>;
    const blocks = [config, ...Object.values(config.env as Record<string, unknown>)] as Record<string, unknown>[];
    expect(blocks.length).toBe(4); // top level, dev, stage, prod
    for (const block of blocks) {
      for (const key of ["d1_databases", "kv_namespaces", "r2_buckets", "durable_objects", "queues", "analytics_engine_datasets", "tail_consumers", "logpush"]) {
        expect([key, block[key]]).toEqual([key, undefined]);
      }
    }
    // The upstream override exists on stage only.
    const bindings = (env: string): string[] => (config.env[env].services as { binding: string }[]).map((s) => s.binding);
    expect(bindings("stage")).toContain("UPSTREAM_OVERRIDE");
    expect(bindings("prod")).toEqual(["IDENTITY_WORKER", "LEDGER_WORKER"]);
    expect(config.env.prod.workers_dev).toBe(true);
  });

  it("7. a streamed call is metered with the same cost_nanousd as the same usage reported through the SDK path", async () => {
    const proxied = w.db
      .prepare("SELECT * FROM ledger_events WHERE source = 'proxy' AND price_status = 'priced' ORDER BY rowid LIMIT 1")
      .get() as any;
    expect(proxied).toMatchObject({ tenant: "acme", feature: "support-bot", end_user: "u-7", provider: "openai", model: "gpt-4o-2024-08-06", priced_model: "gpt-4o", input_tokens: 1000, output_tokens: 500 });
    const sdk = await ledgerRoute(
      new Request(`https://ledger.internal/v1/organizations/${ORG_A_PUBLIC}/llm-events`, {
        method: "POST",
        headers: { "x-actor-subject-id": KEY_A, "x-actor-subject-type": "service_principal", "content-type": "application/json" },
        body: JSON.stringify({ events: [{ eventId: "sdk-twin", tenant: "acme", provider: "openai", model: "gpt-4o-2024-08-06", inputTokens: 1000, outputTokens: 500 }] }),
      }),
      w.ledgerEnv,
    );
    const item = ((await sdk.json()) as any).data.results[0];
    expect(item.costNanoUsd).toBe(proxied.cost_nanousd);
    expect(proxied.cost_nanousd).toBe(7_500_000); // 1000 × $2.50 + 500 × $10.00 per MTok
  });
});

describe("design §7.4 — rules the code follows, checked in the source", () => {
  const SRC = join(REPO, "apps/proxy-worker/src");
  const files = ["auth.ts", "env.ts", "errors.ts", "headers.ts", "ids.ts", "index.ts", "ledger.ts", "log.ts", "meter.ts", "proxy.ts", "upstream.ts"];
  const source = Object.fromEntries(files.map((f) => [f, readFileSync(join(SRC, f), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")]));

  it("1. only forwardHeaders() reads authorization (auth.ts only WRITES the Meterwise key as a bearer to identity)", () => {
    for (const [file, code] of Object.entries(source)) {
      expect([file, /\.get\(\s*["'`]authorization["'`]\s*\)/i.test(code)]).toEqual([file, false]);
      const mentions = (code.match(/authorization/gi) ?? []).length;
      const allowed = file === "headers.ts" ? 1 : file === "auth.ts" ? 1 : 0;
      expect([file, mentions]).toEqual([file, allowed]);
    }
    expect(source["headers.ts"]).toMatch(/const FORWARDED = \["authorization", "content-type", "openai-organization", "openai-project", "accept"\] as const;/);
    expect(source["auth.ts"]).toMatch(/authorization: `Bearer \$\{meterwiseKey\}`/);
  });

  it("2. the only console call is logEvent's", () => {
    for (const [file, code] of Object.entries(source)) {
      const calls = (code.match(/console\.[a-z]+\(/g) ?? []).length;
      expect([file, calls]).toEqual([file, file === "log.ts" ? 1 : 0]);
    }
  });

  it("3. no catch block binds the error, so none can return or log its message", () => {
    for (const [file, code] of Object.entries(source)) expect([file, /catch\s*\(/.test(code)]).toEqual([file, false]);
  });

  it("4. no Request or Headers object is serialised", () => {
    for (const [file, code] of Object.entries(source)) {
      expect([file, /JSON\.stringify\(\s*(request|headers|req|init|incoming|upstream|res|response)\b/.test(code)]).toEqual([file, false]);
      expect([file, /\$\{\s*(request|headers|incoming)\s*\}/.test(code)]).toEqual([file, false]);
    }
  });

  it("the upstream origin is a constant, and nothing reads a base URL from the request", () => {
    expect(source["upstream.ts"]).toContain('export const OPENAI_CHAT_COMPLETIONS = "https://api.openai.com/v1/chat/completions";');
    const all = Object.values(source).join("\n");
    expect(all).not.toMatch(/base[_-]?url/i);
    expect(all.match(/https:\/\/api\.openai\.com/g)).toHaveLength(1);
  });
});
