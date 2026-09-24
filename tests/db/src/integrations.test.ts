import { createIntegrationsRepository } from "@saas/db/integrations";
import { asUuid } from "@saas/db";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";

const ORG_ID = asUuid("00000000-0000-4000-8000-000000000001");
const OTHER_ID = asUuid("00000000-0000-4000-8000-000000000099");
const CONNECTION_ID = asUuid("00000000-0000-4000-8000-000000000002");
const PROJECT_ID = asUuid("00000000-0000-4000-8000-000000000003");
const LINK_ID = asUuid("00000000-0000-4000-8000-000000000004");
const DELIVERY_ID = asUuid("00000000-0000-4000-8000-000000000005");

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(options?: {
  rows?: Record<string, unknown>[];
  rowsBySequence?: Record<string, unknown>[][];
  error?: unknown;
  rowCount?: number;
}): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  let call = 0;
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      if (options?.error) {
        throw options.error;
      }
      const sequence = options?.rowsBySequence;
      const rows = (sequence ? (sequence[call++] ?? []) : (options?.rows ?? [])) as unknown as T[];
      return { rows, rowCount: options?.rowCount ?? rows.length };
    },
  };
  return { executor, queries };
}

const NOW = new Date("2026-06-11T10:00:00Z");

const SAMPLE_CONNECTION_ROW = {
  id: CONNECTION_ID,
  org_id: ORG_ID,
  provider: "github",
  status: "pending",
  display_name: null,
  external_account_login: null,
  external_account_id: null,
  external_account_type: null,
  created_by: "usr_abc",
  state_expires_at: NOW.toISOString(),
  connected_at: null,
  suspended_at: null,
  revoked_at: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_INSTALLATION_ROW = {
  id: "00000000-0000-4000-8000-000000000010",
  connection_id: CONNECTION_ID,
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
};

const SAMPLE_REPO_LINK_ROW = {
  id: LINK_ID,
  org_id: ORG_ID,
  project_id: PROJECT_ID,
  connection_id: CONNECTION_ID,
  repo_external_id: "777",
  repo_full_name: "acme/storefront",
  default_branch: "main",
  branch_env_map: { main: "prod" },
  status: "active",
  created_by: "usr_abc",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_DELIVERY_ROW = {
  id: DELIVERY_ID,
  org_id: null,
  provider: "github",
  delivery_key: "gh-delivery-uuid-1",
  event_type: "push",
  action: null,
  payload: { ref: "refs/heads/main" },
  signature_ok: true,
  status: "received",
  attempts: 0,
  next_attempt_at: null,
  failure_reason: null,
  emitted_event_id: null,
  received_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

describe("IntegrationsRepository — connections", () => {
  it("creates a pending connection with parameterized values", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_CONNECTION_ROW] });
    const repo = createIntegrationsRepository(executor);

    const result = await repo.createConnection({
      id: CONNECTION_ID,
      orgId: ORG_ID,
      provider: "github",
      createdBy: "usr_abc",
      stateNonceHash: "abc123hash",
      stateExpiresAt: NOW,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("pending");
      expect(result.value.orgId).toBe(ORG_ID);
    }
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("integrations_connections");
    expect(queries[0]!.text).toContain("'pending'");
    expect(queries[0]!.params).toContain("abc123hash");
  });

  it("maps a unique violation to a conflict error", async () => {
    const { executor } = createFakeExecutor({ error: new Error("D1_ERROR: UNIQUE constraint failed") });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.createConnection({
      id: CONNECTION_ID,
      orgId: ORG_ID,
      provider: "github",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: "conflict", entity: "connection" });
    }
  });

  it("scopes reads by org_id", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_CONNECTION_ROW] });
    const repo = createIntegrationsRepository(executor);
    await repo.getConnection(ORG_ID, CONNECTION_ID);
    expect(queries[0]!.text).toContain("WHERE org_id = $1 AND id = $2");
    expect(queries[0]!.params).toEqual([ORG_ID, CONNECTION_ID]);
  });

  it("never returns the state nonce hash through the read model", async () => {
    const { executor } = createFakeExecutor({
      rows: [{ ...SAMPLE_CONNECTION_ROW, state_nonce_hash: "should-not-leak" }],
    });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.getConnection(ORG_ID, CONNECTION_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.value)).not.toContain("should-not-leak");
    }
  });

  it("consumes connect state single-use, unexpired, pending-only", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_CONNECTION_ROW] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.consumeConnectionState("noncehash");
    expect(result.ok).toBe(true);
    const sql = queries[0]!.text;
    expect(sql).toContain("SET state_nonce_hash = NULL");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("state_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  });

  it("fails closed when the state nonce does not resolve", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.consumeConnectionState("expired-or-replayed");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not_found");
    }
  });

  it("activates only pending connections and clears the connect state", async () => {
    const activated = {
      ...SAMPLE_CONNECTION_ROW,
      status: "active",
      external_account_login: "acme",
      connected_at: NOW.toISOString(),
    };
    const { executor, queries } = createFakeExecutor({ rows: [activated] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.activateConnection(ORG_ID, CONNECTION_ID, {
      externalAccountLogin: "acme",
      externalAccountId: "42",
      externalAccountType: "Organization",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("active");
    }
    const sql = queries[0]!.text;
    expect(sql).toContain("AND status = 'pending'");
    expect(sql).toContain("state_expires_at = NULL");
  });

  it("stamps revoked_at when revoking", async () => {
    const revoked = { ...SAMPLE_CONNECTION_ROW, status: "revoked", revoked_at: NOW.toISOString() };
    const { executor, queries } = createFakeExecutor({ rows: [revoked] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.updateConnectionStatus(ORG_ID, CONNECTION_ID, "revoked");
    expect(result.ok).toBe(true);
    expect(queries[0]!.params).toEqual([ORG_ID, CONNECTION_ID, "revoked"]);
  });

  it("paginates connection lists with keyset cursors", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_CONNECTION_ROW] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.listConnections(ORG_ID, {
      limit: 20,
      cursor: { createdAt: NOW.toISOString(), id: CONNECTION_ID },
    });
    expect(result.ok).toBe(true);
    const sql = queries[0]!.text;
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(sql).toContain("(created_at, id) <");
  });
});

describe("IntegrationsRepository — GitHub installations", () => {
  it("upserts keyed by installation_id and preserves an existing binding", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_INSTALLATION_ROW] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.upsertGithubInstallation({
      id: SAMPLE_INSTALLATION_ROW.id,
      connectionId: CONNECTION_ID,
      installationId: 9912345,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
      permissions: { contents: "read" },
      events: ["push"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.installationId).toBe(9912345);
      expect(result.value.connectionId).toBe(CONNECTION_ID);
    }
    const sql = queries[0]!.text;
    expect(sql).toContain("ON CONFLICT (installation_id)");
    // An orphan re-delivery (connection_id NULL) must never clear a binding.
    expect(sql).toContain("COALESCE(EXCLUDED.connection_id, integrations_github_installations.connection_id)");
  });

  it("supports orphaned installations (no connection binding)", async () => {
    const orphanRow = { ...SAMPLE_INSTALLATION_ROW, connection_id: null };
    const { executor } = createFakeExecutor({ rows: [orphanRow] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.upsertGithubInstallation({
      id: SAMPLE_INSTALLATION_ROW.id,
      installationId: 9912345,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.connectionId).toBeNull();
    }
  });

  it("looks up by installation id", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_INSTALLATION_ROW] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.getGithubInstallationByInstallationId(9912345);
    expect(result.ok).toBe(true);
    expect(queries[0]!.params).toEqual([9912345]);
  });
});

describe("IntegrationsRepository — repo links", () => {
  it("creates an org+project scoped link with a branch map", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_REPO_LINK_ROW] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.createRepoLink({
      id: LINK_ID,
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      connectionId: CONNECTION_ID,
      repoExternalId: "777",
      repoFullName: "acme/storefront",
      defaultBranch: "main",
      branchEnvMap: { main: "prod" },
      createdBy: "usr_abc",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.branchEnvMap).toEqual({ main: "prod" });
    }
    expect(queries[0]!.text).toContain("integrations_repo_links");
    expect(queries[0]!.params[1]).toBe(ORG_ID);
    expect(queries[0]!.params[2]).toBe(PROJECT_ID);
  });

  it("maps duplicate active links to conflict", async () => {
    const { executor } = createFakeExecutor({ error: new Error("D1_ERROR: UNIQUE constraint failed") });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.createRepoLink({
      id: LINK_ID,
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      connectionId: CONNECTION_ID,
      repoExternalId: "777",
      repoFullName: "acme/storefront",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: "conflict", entity: "repo_link" });
    }
  });

  it("filters list by project when given", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_REPO_LINK_ROW] });
    const repo = createIntegrationsRepository(executor);
    await repo.listRepoLinks(ORG_ID, { limit: 10, cursor: null }, { projectId: PROJECT_ID, status: "active" });
    const sql = queries[0]!.text;
    expect(sql).toContain("AND project_id = $2");
    expect(sql).toContain("AND status = $3");
  });

  it("soft-unlinks only active rows, org-scoped", async () => {
    const unlinked = { ...SAMPLE_REPO_LINK_ROW, status: "unlinked" };
    const { executor, queries } = createFakeExecutor({ rows: [unlinked] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.unlinkRepoLink(ORG_ID, LINK_ID);
    expect(result.ok).toBe(true);
    const sql = queries[0]!.text;
    expect(sql).toContain("SET status = 'unlinked'");
    expect(sql).toContain("WHERE org_id = $1 AND id = $2 AND status = 'active'");
  });

  it("returns not_found when unlinking another org's link", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.unlinkRepoLink(OTHER_ID, LINK_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not_found");
    }
  });
});

describe("IntegrationsRepository — inbound deliveries (durable inbox)", () => {
  it("inserts a new delivery with created=true", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_DELIVERY_ROW] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.insertInboundDelivery({
      id: DELIVERY_ID,
      provider: "github",
      deliveryKey: "gh-delivery-uuid-1",
      eventType: "push",
      payload: { ref: "refs/heads/main" },
      signatureOk: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.created).toBe(true);
      expect(result.value.delivery.status).toBe("received");
    }
    expect(queries[0]!.text).toContain("ON CONFLICT (provider, delivery_key) DO NOTHING");
  });

  it("treats a redelivery as a no-op returning the existing row", async () => {
    const { executor, queries } = createFakeExecutor({
      rowsBySequence: [[], [SAMPLE_DELIVERY_ROW]],
    });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.insertInboundDelivery({
      id: asUuid("00000000-0000-4000-8000-000000000006"),
      provider: "github",
      deliveryKey: "gh-delivery-uuid-1",
      eventType: "push",
      payload: { ref: "refs/heads/main" },
      signatureOk: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.created).toBe(false);
      expect(result.value.delivery.id).toBe(DELIVERY_ID);
    }
    expect(queries).toHaveLength(2);
    expect(queries[1]!.text).toContain("WHERE provider = $1 AND delivery_key = $2");
  });

  it("scans due work oldest-first for the cron drain", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_DELIVERY_ROW] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.listDueInboundDeliveries(50);
    expect(result.ok).toBe(true);
    const sql = queries[0]!.text;
    expect(sql).toContain("status IN ('received', 'attributed')");
    expect(sql).toContain("next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    expect(sql).toContain("ORDER BY received_at ASC, id ASC");
  });

  it("marks attribution and emission transitions", async () => {
    const attributed = { ...SAMPLE_DELIVERY_ROW, org_id: ORG_ID, status: "attributed" };
    const { executor, queries } = createFakeExecutor({ rows: [attributed] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.markInboundDelivery(DELIVERY_ID, {
      orgId: ORG_ID,
      status: "attributed",
      attempts: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.orgId).toBe(ORG_ID);
      expect(result.value.status).toBe("attributed");
    }
    expect(queries[0]!.params[0]).toBe(DELIVERY_ID);
  });

  it("lists the org-scoped delivery log keyed by received_at", async () => {
    const { executor, queries } = createFakeExecutor({
      rows: [{ ...SAMPLE_DELIVERY_ROW, org_id: ORG_ID }],
    });
    const repo = createIntegrationsRepository(executor);
    await repo.listInboundDeliveries(ORG_ID, { limit: 10, cursor: null });
    const sql = queries[0]!.text;
    expect(sql).toContain("WHERE org_id = $1");
    expect(sql).toContain("ORDER BY received_at DESC, id DESC");
  });
});

describe("IntegrationsRepository — installation token cache", () => {
  const SAMPLE_TOKEN_ROW = {
    id: "00000000-0000-4000-8000-000000000020",
    connection_id: CONNECTION_ID,
    token_ciphertext: "v1:abc:ciphertext",
    permissions: { contents: "read" },
    repository_ids: [777],
    expires_at: NOW.toISOString(),
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };

  it("upserts one cache entry per connection", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_TOKEN_ROW] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.upsertInstallationToken({
      id: SAMPLE_TOKEN_ROW.id,
      connectionId: CONNECTION_ID,
      tokenCiphertext: "v1:abc:ciphertext",
      permissions: { contents: "read" },
      repositoryIds: [777],
      expiresAt: NOW,
    });
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("ON CONFLICT (connection_id) DO UPDATE");
  });

  it("only returns unexpired tokens", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_TOKEN_ROW] });
    const repo = createIntegrationsRepository(executor);
    await repo.getInstallationToken(CONNECTION_ID);
    expect(queries[0]!.text).toContain("expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  });

  it("deletes the cache entry on revoke", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.deleteInstallationToken(CONNECTION_ID);
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("DELETE FROM integrations_installation_tokens");
  });

  it("returns a safe internal error without leaking driver details", async () => {
    const { executor } = createFakeExecutor({ error: new Error("connection refused at 10.0.0.5") });
    const repo = createIntegrationsRepository(executor);
    const result = await repo.getInstallationToken(CONNECTION_ID);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "internal") {
      expect(result.error.message).not.toContain("10.0.0.5");
    }
  });
});
