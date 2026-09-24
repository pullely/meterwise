import {
  handleConnectIntegration,
  handleRevokeIntegration,
} from "@integrations-worker/handlers/connections";
import { handleGithubSetupCallback } from "@integrations-worker/handlers/setup";
import { signConnectState, hashStateNonce, CONNECT_STATE_TTL_MS } from "@integrations-worker/state";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";
import { asUuid } from "@saas/db";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_UUID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = asUuid(ORG_UUID);
const STATE_SECRET = "state-secret";
const NOW = new Date("2026-06-11T10:00:00Z");

// ── Fakes ────────────────────────────────────────────────────

type QueryRecord = { text: string; params: unknown[] };
type SqlResponder = (text: string, params: unknown[]) => Record<string, unknown>[] | null;

function fakeExecutor(respond: SqlResponder): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { executor, queries };
}

function jsonFetcher(body: unknown): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json(body)),
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function membershipFetcher(): Fetcher {
  return jsonFetcher({
    data: {
      memberships: [
        { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_UUID } },
      ],
    },
  });
}

function policyFetcher(allow: boolean): Fetcher {
  return jsonFetcher({ data: { allow, reason: allow ? "org_admin" : "no_matching_role" } });
}

function billingFetcher(allowed: boolean, reason?: string): Fetcher {
  return jsonFetcher({
    data: {
      allowed,
      orgId: `org_${ORG_UUID.replace(/-/g, "")}`,
      entitlementKey: "feature.integrations.github",
      ...(reason ? { reason } : {}),
    },
  });
}

function createEnv(overrides?: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: membershipFetcher(),
    POLICY_WORKER: policyFetcher(true),
    BILLING_WORKER: billingFetcher(true),
    INTEGRATIONS_STATE_SECRET: STATE_SECRET,
    GITHUB_APP_ID: "4242",
    GITHUB_APP_SLUG: "sourceplane-test",
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    GITHUB_APP_WEBHOOK_SECRET: "whsec",
    ...overrides,
  } as unknown as Env;
}

const ACTOR = {
  subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  subjectType: "user",
};

// A real PKCS#8 key so completeConnect can mint a verifiable App JWT.
let TEST_PRIVATE_KEY_PEM = "";
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const bytes = new Uint8Array(der);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin).match(/.{1,64}/g)!.join("\n");
  TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}, 30_000); // RSA keygen can crawl under full-workspace test parallelism


function pendingRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ORG_UUID,
    provider: "github",
    status: "pending",
    display_name: null,
    external_account_login: null,
    external_account_id: null,
    external_account_type: null,
    created_by: "usr_abc",
    state_expires_at: new Date(NOW.getTime() + CONNECT_STATE_TTL_MS).toISOString(),
    connected_at: null,
    suspended_at: null,
    revoked_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

// ── Connect ─────────────────────────────────────────────────

describe("POST .../integrations/github/connect", () => {
  function connectRequest(): Request {
    return new Request("https://worker.test/v1/organizations/x/integrations/github/connect", {
      method: "POST",
      headers: { "content-length": "0" },
    });
  }

  it("denies via policy as 404 (no resource disclosure)", async () => {
    const env = createEnv({ POLICY_WORKER: policyFetcher(false) });
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, {
      executor,
    });
    expect(res.status).toBe(404);
    expect(queries).toHaveLength(0); // denied before any DB touch
  });

  it("returns 412 with the entitlement reason when the plan lacks the feature", async () => {
    const env = createEnv({ BILLING_WORKER: billingFetcher(false, "disabled") });
    const { executor } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, {
      executor,
    });
    expect(res.status).toBe(412);
    const body = await json(res);
    const error = body.error as Record<string, unknown>;
    expect(error.code).toBe("precondition_failed");
    expect((error.details as Record<string, unknown>).reason).toBe("disabled");
  });

  it("parks on D1 with 412/not_configured when the App secrets are unset", async () => {
    const env = createEnv({ GITHUB_APP_ID: undefined });
    const { executor } = fakeExecutor(() => []);
    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, {
      executor,
    });
    expect(res.status).toBe(412);
    const error = (await json(res)).error as Record<string, unknown>;
    expect((error.details as Record<string, unknown>).gate).toBe("github_app_registration");
  });

  it("creates a pending connection and returns the install URL with signed state", async () => {
    const env = createEnv();
    let insertedParams: unknown[] = [];
    const { executor } = fakeExecutor((text, params) => {
      if (text.includes("INSERT INTO integrations_connections")) {
        insertedParams = params;
        return [pendingRow({ id: params[0] as string })];
      }
      return [];
    });

    const res = await handleConnectIntegration(connectRequest(), env, "req_1", ACTOR, ORG_ID, {
      executor,
    });
    expect(res.status).toBe(201);
    const data = (await json(res)).data as Record<string, unknown>;
    const connection = data.connection as Record<string, unknown>;
    expect(connection.status).toBe("pending");

    const installUrl = new URL(data.installUrl as string);
    expect(installUrl.origin + installUrl.pathname).toBe(
      "https://github.com/apps/sourceplane-test/installations/new",
    );
    const state = installUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    // The DB stores the SHA-256 of the nonce, never the raw nonce or state.
    const storedNonceHash = insertedParams[5] as string;
    expect(storedNonceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(state).not.toContain(storedNonceHash);
  });
});

// ── Setup callback (the tenancy keystone, R1 test plan) ─────

describe("GET /ingress/github/setup", () => {
  function setupRequest(params: Record<string, string>): Request {
    const url = new URL("https://worker.test/ingress/github/setup");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return new Request(url.toString(), { method: "GET" });
  }

  async function mintState(overrides?: Partial<{ n: string; p: string; c: string; o: string; exp: number }>): Promise<{ state: string; nonce: string }> {
    const nonce = overrides?.n ?? "f".repeat(32);
    const state = await signConnectState(
      {
        n: nonce,
        p: overrides?.p ?? "github",
        c: overrides?.c ?? CONNECTION_UUID,
        o: overrides?.o ?? ORG_UUID,
        exp: overrides?.exp ?? Date.now() + CONNECT_STATE_TTL_MS,
      },
      STATE_SECRET,
    );
    return { state, nonce };
  }

  const githubFetch = (facts?: Partial<Record<string, unknown>>) =>
    ((input: string) => {
      if (input.includes("/app/installations/")) {
        return Promise.resolve(
          Response.json({
            id: 9912345,
            account: { login: "acme", id: 42, type: "Organization" },
            repository_selection: "selected",
            permissions: { contents: "read" },
            events: ["push"],
            suspended_at: null,
            ...facts,
          }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

  it("records an unsolicited install (no state) as orphaned and fails closed", async () => {
    const env = createEnv();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("INSERT INTO integrations_github_installations")) {
        return [{ id: "x", connection_id: null, installation_id: "9912345", created_at: NOW.toISOString(), updated_at: NOW.toISOString() }];
      }
      return [];
    });

    const res = await handleGithubSetupCallback(
      setupRequest({ installation_id: "9912345" }),
      env,
      "req_1",
      { executor, fetchImpl: githubFetch() },
    );
    expect(res.status).toBe(400);
    const orphanInsert = queries.find((q) =>
      q.text.includes("INSERT INTO integrations_github_installations"),
    );
    expect(orphanInsert).toBeDefined();
    expect(orphanInsert!.params[1]).toBeNull(); // connection_id NULL = orphaned
    // No connection was activated.
    expect(queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
  });

  it("treats replayed/expired state (nonce no longer consumable) as orphaned", async () => {
    const env = createEnv();
    const { state } = await mintState();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return []; // already consumed
      if (text.includes("INSERT INTO integrations_github_installations")) {
        return [{ id: "x", connection_id: null, installation_id: "9912345", created_at: NOW.toISOString(), updated_at: NOW.toISOString() }];
      }
      return [];
    });

    const res = await handleGithubSetupCallback(
      setupRequest({ installation_id: "9912345", state }),
      env,
      "req_1",
      { executor, fetchImpl: githubFetch() },
    );
    expect(res.status).toBe(400);
    expect(
      queries.some((q) => q.text.includes("INSERT INTO integrations_github_installations")),
    ).toBe(true);
  });

  it("rejects state whose payload disagrees with the consumed row (cross-org redemption)", async () => {
    const env = createEnv();
    // State minted for ANOTHER org, but the nonce resolves to ORG_UUID's row.
    const { state } = await mintState({ o: OTHER_ORG_UUID });
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      if (text.includes("INSERT INTO integrations_github_installations")) {
        return [{ id: "x", connection_id: null, installation_id: "9912345", created_at: NOW.toISOString(), updated_at: NOW.toISOString() }];
      }
      return [];
    });

    const res = await handleGithubSetupCallback(
      setupRequest({ installation_id: "9912345", state }),
      env,
      "req_1",
      { executor, fetchImpl: githubFetch() },
    );
    expect(res.status).toBe(400);
    expect(queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
  });

  it("activates the pending connection on a valid single-use state", async () => {
    const env = createEnv();
    const { state, nonce } = await mintState();
    const expectedHash = await hashStateNonce(nonce);

    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("SET state_nonce_hash = NULL")) {
        expect(params[0]).toBe(expectedHash);
        return [pendingRow()];
      }
      if (text.includes("INSERT INTO integrations_github_installations")) {
        return [
          {
            id: "inst-row",
            connection_id: CONNECTION_UUID,
            installation_id: "9912345",
            account_login: "acme",
            account_id: "42",
            account_type: "Organization",
            repository_selection: "selected",
            permissions: { contents: "read" },
            events: ["push"],
            suspended_at: null,
            created_at: NOW.toISOString(),
            updated_at: NOW.toISOString(),
          },
        ];
      }
      if (text.includes("SET status = 'active'")) {
        return [
          pendingRow({
            status: "active",
            external_account_login: "acme",
            external_account_id: "42",
            external_account_type: "Organization",
            connected_at: NOW.toISOString(),
          }),
        ];
      }
      if (text.includes("INSERT INTO")) return [{ id: "evt" }]; // events + audit
      return [];
    });

    const res = await handleGithubSetupCallback(
      setupRequest({ installation_id: "9912345", state, setup_action: "install" }),
      env,
      "req_1",
      { executor, fetchImpl: githubFetch() },
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("GitHub connected");

    const activate = queries.find((q) => q.text.includes("SET status = 'active'"));
    expect(activate).toBeDefined();
    expect(activate!.params[0]).toBe(ORG_UUID);
    expect(activate!.params[1]).toBe(CONNECTION_UUID);
    // The installation row is bound to the connection from the state, never
    // from anything GitHub sent.
    const install = queries.find((q) =>
      q.text.includes("INSERT INTO integrations_github_installations"),
    );
    expect(install!.params[1]).toBe(CONNECTION_UUID);
  });

  it("refuses to flip an installation already bound to another connection", async () => {
    const env = createEnv();
    const { state } = await mintState();
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SET state_nonce_hash = NULL")) return [pendingRow()];
      if (text.includes("INSERT INTO integrations_github_installations")) {
        // Upsert resolves to a row owned by a DIFFERENT connection.
        return [
          {
            id: "inst-row",
            connection_id: "44444444-4444-4444-8444-444444444444",
            installation_id: "9912345",
            created_at: NOW.toISOString(),
            updated_at: NOW.toISOString(),
          },
        ];
      }
      return [];
    });

    const res = await handleGithubSetupCallback(
      setupRequest({ installation_id: "9912345", state }),
      env,
      "req_1",
      { executor, fetchImpl: githubFetch() },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Already connected");
    expect(queries.some((q) => q.text.includes("SET status = 'active'"))).toBe(false);
  });
});

// ── Revoke ──────────────────────────────────────────────────

describe("DELETE .../integrations/{id}", () => {
  it("revokes, clears the token cache, and is idempotent", async () => {
    const env = createEnv();
    let status = "active";
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("SELECT * FROM integrations_connections")) {
        return [pendingRow({ status, external_account_login: "acme" })];
      }
      if (text.includes("SET status = $3")) {
        status = "revoked";
        return [pendingRow({ status: "revoked", revoked_at: NOW.toISOString() })];
      }
      if (text.includes("SELECT * FROM integrations_github_installations")) return [];
      return [{ id: "x" }];
    });

    const first = await handleRevokeIntegration(env, "req_1", ACTOR, ORG_ID, asUuid(CONNECTION_UUID), {
      executor,
    });
    expect(first.status).toBe(200);
    expect(queries.some((q) => q.text.includes("DELETE FROM integrations_installation_tokens"))).toBe(true);

    const second = await handleRevokeIntegration(env, "req_2", ACTOR, ORG_ID, asUuid(CONNECTION_UUID), {
      executor,
    });
    expect(second.status).toBe(200); // idempotent — already revoked
  });

  it("404s for a connection in another org", async () => {
    const env = createEnv();
    const { executor } = fakeExecutor(() => []);
    const res = await handleRevokeIntegration(
      env,
      "req_1",
      ACTOR,
      asUuid(OTHER_ORG_UUID),
      asUuid(CONNECTION_UUID),
      { executor },
    );
    expect(res.status).toBe(404);
  });
});
