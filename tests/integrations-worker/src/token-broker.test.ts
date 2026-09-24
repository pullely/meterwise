import {
  handleIssueGithubToken,
  permissionsWithinGrant,
} from "@integrations-worker/handlers/token-broker";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";
import { asUuid } from "@saas/db";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const PROJECT_UUID = "44444444-4444-4444-8444-444444444444";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const INSTALLATION_ID = 9912345;
const NOW = new Date("2026-06-11T10:00:00Z");
const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

type QueryRecord = { text: string; params: unknown[] };

function fakeExecutor(
  respond: (text: string, params: unknown[]) => Record<string, unknown>[] | null,
): { executor: SqlExecutor; queries: QueryRecord[] } {
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

let TEST_PRIVATE_KEY_PEM = "";
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const bytes = new Uint8Array(der);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}, 30_000); // RSA keygen can crawl under full-workspace test parallelism


function createEnv(overrides?: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: jsonFetcher({
      data: {
        memberships: [
          { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_UUID } },
        ],
      },
    }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true, reason: "org_admin" } }),
    BILLING_WORKER: jsonFetcher({
      data: { allowed: true, orgId: `org_x`, entitlementKey: "feature.integrations.github" },
    }),
    GITHUB_APP_ID: "4242",
    GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY_PEM,
    ...overrides,
  } as unknown as Env;
}

function linkRow(): Record<string, unknown> {
  return {
    id: "ln1",
    org_id: ORG_UUID,
    project_id: PROJECT_UUID,
    connection_id: CONNECTION_UUID,
    repo_external_id: "777001",
    repo_full_name: "acme/storefront",
    default_branch: "main",
    branch_env_map: {},
    status: "active",
    created_by: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function connectionRow(): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ORG_UUID,
    provider: "github",
    status: "active",
    display_name: "acme",
    external_account_login: "acme",
    external_account_id: "42",
    external_account_type: "Organization",
    created_by: null,
    state_expires_at: null,
    connected_at: NOW.toISOString(),
    suspended_at: null,
    revoked_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function installationRow(permissions: Record<string, string>): Record<string, unknown> {
  return {
    id: "inst1",
    connection_id: CONNECTION_UUID,
    installation_id: String(INSTALLATION_ID),
    account_login: "acme",
    account_id: "42",
    account_type: "Organization",
    repository_selection: "selected",
    permissions,
    events: ["push"],
    suspended_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
}

function tokenRequest(body: Record<string, unknown>): Request {
  return new Request("https://worker.test/v1/organizations/x/integrations/github/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const githubFetch = (calls: Array<{ url: string; body: unknown }>) =>
  ((input: string, init?: RequestInit) => {
    calls.push({ url: input, body: init?.body ? JSON.parse(init.body as string) : null });
    if (input.includes("/access_tokens")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            token: "ghs_scoped_secret",
            expires_at: "2026-06-11T11:00:00Z",
            permissions: { checks: "write" },
          }),
          { status: 201 },
        ),
      );
    }
    return Promise.resolve(new Response("nf", { status: 404 }));
  });

describe("permissionsWithinGrant (deny-by-default)", () => {
  const GRANT = { contents: "read", checks: "write", metadata: "read" };

  it("accepts requested ⊆ granted", () => {
    expect(permissionsWithinGrant({ contents: "read" }, GRANT)).toBe(true);
    expect(permissionsWithinGrant({ checks: "write" }, GRANT)).toBe(true);
    expect(permissionsWithinGrant({ checks: "read" }, GRANT)).toBe(true);
  });

  it("rejects escalation and unknown keys", () => {
    expect(permissionsWithinGrant({ contents: "write" }, GRANT)).toBe(false); // read → write
    expect(permissionsWithinGrant({ issues: "read" }, GRANT)).toBe(false); // not granted
    expect(permissionsWithinGrant({ checks: "write" }, null)).toBe(false); // no grant snapshot
  });
});

describe("POST .../integrations/github/token (the broker)", () => {
  it("mints a scoped token for linked repos and audits without the token", async () => {
    const ghCalls: Array<{ url: string; body: unknown }> = [];
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_repo_links")) return [linkRow()];
      if (text.includes("FROM integrations_connections WHERE org_id")) return [connectionRow()];
      if (text.includes("FROM integrations_github_installations"))
        return [installationRow({ checks: "write", contents: "read" })];
      return [{ _event: {}, _audit: {} }];
    });

    const res = await handleIssueGithubToken(
      tokenRequest({ repositories: ["777001"], permissions: { checks: "write" } }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor, fetchImpl: githubFetch(ghCalls) },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.token).toBe("ghs_scoped_secret");
    expect(body.data.expiresAt).toBe("2026-06-11T11:00:00Z");

    // GitHub got the scoped-down request.
    expect(ghCalls[0]!.url).toContain(`/app/installations/${INSTALLATION_ID}/access_tokens`);
    expect(ghCalls[0]!.body).toEqual({
      repository_ids: [777001],
      permissions: { checks: "write" },
    });

    // Audited — actor + scope, never the token; nothing cached.
    const audit = queries.find((q) => q.text.includes("events_event_log"));
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit!.params)).not.toContain("ghs_scoped_secret");
    expect(queries.some((q) => q.text.includes("installation_tokens"))).toBe(false);
  });

  it("denies unlinked repositories with a safe 412", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_repo_links")) return [];
      return [];
    });
    const res = await handleIssueGithubToken(
      tokenRequest({ repositories: ["999"], permissions: { checks: "write" } }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor, fetchImpl: githubFetch([]) },
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { details: Record<string, unknown> } };
    expect(body.error.details.reason).toBe("repository_not_linked");
  });

  it("denies permissions exceeding the App grant", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_repo_links")) return [linkRow()];
      if (text.includes("FROM integrations_connections WHERE org_id")) return [connectionRow()];
      if (text.includes("FROM integrations_github_installations"))
        return [installationRow({ contents: "read" })];
      return [];
    });
    const res = await handleIssueGithubToken(
      tokenRequest({ repositories: ["777001"], permissions: { contents: "write" } }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor, fetchImpl: githubFetch([]) },
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { details: Record<string, unknown> } };
    expect(body.error.details.reason).toBe("permissions_exceed_grant");
  });

  it("denies via policy as 404 and validates the body shape", async () => {
    const deniedEnv = createEnv({ POLICY_WORKER: jsonFetcher({ data: { allow: false } }) });
    const { executor } = fakeExecutor(() => []);
    const denied = await handleIssueGithubToken(
      tokenRequest({ repositories: ["777001"], permissions: { checks: "write" } }),
      deniedEnv,
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor, fetchImpl: githubFetch([]) },
    );
    expect(denied.status).toBe(404);

    const emptyRepos = await handleIssueGithubToken(
      tokenRequest({ repositories: [], permissions: { checks: "write" } }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor, fetchImpl: githubFetch([]) },
    );
    expect(emptyRepos.status).toBe(422);

    const badLevel = await handleIssueGithubToken(
      tokenRequest({ repositories: ["777001"], permissions: { checks: "admin" } }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      { executor, fetchImpl: githubFetch([]) },
    );
    expect(badLevel.status).toBe(422);
  });
});
