import {
  handleCreateRepoLink,
  handleUnlinkRepoLink,
} from "@integrations-worker/handlers/repo-links";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";
import { asUuid } from "@saas/db";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const PROJECT_UUID = "44444444-4444-4444-8444-444444444444";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const LINK_UUID = "55555555-5555-4555-8555-555555555555";
const CONNECTION_PUBLIC = `int_${CONNECTION_UUID.replace(/-/g, "")}`;
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
      data: {
        allowed: true,
        orgId: `org_${ORG_UUID.replace(/-/g, "")}`,
        entitlementKey: "limit.repo_links",
        valueType: "quantity",
        limitValue: 1,
      },
    }),
    PROJECTS_WORKER: jsonFetcher({
      data: {
        environments: [
          { id: "e1", slug: "prod", name: "Production", status: "active" },
          { id: "e2", slug: "stage", name: "Staging", status: "active" },
        ],
      },
    }),
    ...overrides,
  } as unknown as Env;
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

function linkRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: LINK_UUID,
    org_id: ORG_UUID,
    project_id: PROJECT_UUID,
    connection_id: CONNECTION_UUID,
    repo_external_id: "777001",
    repo_full_name: "acme/storefront",
    default_branch: "main",
    branch_env_map: { main: "prod" },
    status: "active",
    created_by: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function createRequest(body: Record<string, unknown>): Request {
  return new Request("https://worker.test/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  connectionId: CONNECTION_PUBLIC,
  repoExternalId: "777001",
  repoFullName: "acme/storefront",
  defaultBranch: "main",
  branchEnvMap: { main: "prod" },
};

describe("POST .../projects/{id}/repo-links", () => {
  it("creates a link, validating the branch map against live environments", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_connections WHERE org_id")) return [connectionRow()];
      if (text.includes("COUNT(*)::int")) return [{ count: 0 }];
      if (text.includes("INSERT INTO integrations_repo_links")) return [linkRow()];
      return [{ _event: {}, _audit: {} }];
    });
    const res = await handleCreateRepoLink(
      createRequest(VALID_BODY),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      asUuid(PROJECT_UUID),
      { executor },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { repoLink: Record<string, unknown> } };
    expect(body.data.repoLink.branchEnvMap).toEqual({ main: "prod" });
    expect(body.data.repoLink.id).toMatch(/^repl_/);
    expect(queries.some((q) => q.text.includes("events_event_log"))).toBe(true);
  });

  it("rejects branch maps pointing at unknown environments (422)", async () => {
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleCreateRepoLink(
      createRequest({ ...VALID_BODY, branchEnvMap: { main: "qa" } }),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      asUuid(PROJECT_UUID),
      { executor },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details: { fields: Record<string, string[]> } } };
    expect(body.error.details.fields.branchEnvMap![0]).toContain("qa");
    expect(queries).toHaveLength(0); // rejected before any DB write
  });

  it("enforces limit.repo_links with 412 limit_reached + usage details", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_connections WHERE org_id")) return [connectionRow()];
      if (text.includes("COUNT(*) AS count")) return [{ count: 1 }]; // at the limit of 1
      return [];
    });
    const res = await handleCreateRepoLink(
      createRequest(VALID_BODY),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      asUuid(PROJECT_UUID),
      { executor },
    );
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { details: Record<string, unknown> } };
    expect(body.error.details.reason).toBe("limit_reached");
    expect(body.error.details.currentUsage).toBe(1);
    expect(body.error.details.limitValue).toBe(1);
  });

  it("404s when the connection is not active in this org", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_connections WHERE org_id"))
        return [{ ...connectionRow(), status: "revoked" }];
      return [];
    });
    const res = await handleCreateRepoLink(
      createRequest(VALID_BODY),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      asUuid(PROJECT_UUID),
      { executor },
    );
    expect(res.status).toBe(404);
  });

  it("maps duplicate active links to 409", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_connections WHERE org_id")) return [connectionRow()];
      if (text.includes("COUNT(*)::int")) return [{ count: 0 }];
      if (text.includes("INSERT INTO integrations_repo_links")) throw new Error("D1_ERROR: UNIQUE constraint failed");
      return [];
    });
    const res = await handleCreateRepoLink(
      createRequest(VALID_BODY),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      asUuid(PROJECT_UUID),
      { executor },
    );
    expect(res.status).toBe(409);
  });
});

describe("DELETE .../repo-links/{id}", () => {
  it("soft-unlinks and emits scm.repo.unlinked", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_repo_links WHERE org_id")) return [linkRow()];
      if (text.includes("SET status = 'unlinked'")) return [linkRow({ status: "unlinked" })];
      return [{ _event: {}, _audit: {} }];
    });
    const res = await handleUnlinkRepoLink(
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      asUuid(PROJECT_UUID),
      asUuid(LINK_UUID),
      { executor },
    );
    expect(res.status).toBe(200);
    expect(queries.some((q) => q.text.includes("SET status = 'unlinked'"))).toBe(true);
    const event = queries.find((q) => q.text.includes("events_event_log"));
    expect(event!.params[1]).toBe("scm.repo.unlinked");
  });

  it("404s when the link belongs to another project", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_repo_links WHERE org_id"))
        return [linkRow({ project_id: "99999999-9999-4999-8999-999999999999" })];
      return [];
    });
    const res = await handleUnlinkRepoLink(
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      asUuid(PROJECT_UUID),
      asUuid(LINK_UUID),
      { executor },
    );
    expect(res.status).toBe(404);
  });
});
