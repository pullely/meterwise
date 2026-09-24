import {
  createWebhookRepository,
} from "@saas/db/webhooks";
import { asUuid } from "@saas/db";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";

// Valid canonical UUIDs. webhook_endpoints/subscriptions org_id & project_id are
// UUID columns, so the branded create inputs require real UUIDs (not slugs).
const ORG_ID = asUuid("00000000-0000-4000-8000-000000000001");
const PROJECT_ID = asUuid("00000000-0000-4000-8000-000000000002");

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(options?: {
  rows?: Record<string, unknown>[];
  error?: unknown;
  rowCount?: number;
}): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      if (options?.error) {
        throw options.error;
      }
      const rows = (options?.rows ?? []) as unknown as T[];
      return { rows, rowCount: options?.rowCount ?? rows.length };
    },
  };
  return { executor, queries };
}

const NOW = new Date("2026-01-15T10:00:00Z");

const SAMPLE_ENDPOINT_ROW = {
  id: "ep-001",
  org_id: ORG_ID,
  project_id: null,
  url: "https://example.com/webhook",
  name: "My Webhook",
  description: "Test endpoint",
  status: "active",
  disabled_reason: null,
  disabled_at: null,
  secret_version: 1,
  secret_last_rotated_at: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_SUBSCRIPTION_ROW = {
  id: "sub-001",
  org_id: ORG_ID,
  endpoint_id: "ep-001",
  project_id: null,
  event_type: "project.created",
  enabled: true,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_DELIVERY_ROW = {
  id: "del-001",
  org_id: ORG_ID,
  endpoint_id: "ep-001",
  subscription_id: "sub-001",
  event_id: "evt-001",
  event_type: "project.created",
  status: "pending",
  attempt_number: 1,
  http_status_code: null,
  failure_reason: null,
  idempotency_key: null,
  next_retry_at: null,
  completed_at: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

// ── Endpoint tests ────────────────────────────────────────

describe("WebhookRepository — Endpoints", () => {
  it("creates an org-scoped endpoint with parameterized query", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ENDPOINT_ROW] });
    const repo = createWebhookRepository(executor);
    const result = await repo.createEndpoint({
      id: "ep-001",
      orgId: ORG_ID,
      url: "https://example.com/webhook",
      name: "My Webhook",
      description: "Test endpoint",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("ep-001");
      expect(result.value.orgId).toBe(ORG_ID);
      expect(result.value.projectId).toBeNull();
      expect(result.value.status).toBe("active");
      expect(result.value.secretVersion).toBe(1);
    }
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("webhooks_webhook_endpoints");
    expect(queries[0]!.params[2]).toBeNull(); // project_id null
  });

  it("creates a project-scoped endpoint with orgId + projectId", async () => {
    const row = { ...SAMPLE_ENDPOINT_ROW, project_id: PROJECT_ID };
    const { executor, queries } = createFakeExecutor({ rows: [row] });
    const repo = createWebhookRepository(executor);
    await repo.createEndpoint({
      id: "ep-002",
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      url: "https://example.com/webhook",
    });
    expect(queries[0]!.params[1]).toBe(ORG_ID); // org_id
    expect(queries[0]!.params[2]).toBe(PROJECT_ID); // project_id
  });

  it("does not expose secret_ciphertext in RETURNING clause", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ENDPOINT_ROW] });
    const repo = createWebhookRepository(executor);
    await repo.createEndpoint({
      id: "ep-001",
      orgId: ORG_ID,
      url: "https://example.com/webhook",
    });
    expect(queries[0]!.text).not.toContain("secret_ciphertext");
  });

  it("does not expose secret_ciphertext on get", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ENDPOINT_ROW] });
    const repo = createWebhookRepository(executor);
    const result = await repo.getEndpoint(ORG_ID, "ep-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("secretCiphertext" in result.value).toBe(false);
      expect("secret_ciphertext" in result.value).toBe(false);
    }
    expect(queries[0]!.text).not.toContain("secret_ciphertext");
    expect(queries[0]!.text).not.toContain("SELECT *");
  });

  it("does not expose secret_ciphertext on list", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ENDPOINT_ROW] });
    const repo = createWebhookRepository(executor);
    await repo.listEndpoints(ORG_ID, { limit: 10, cursor: null });
    expect(queries[0]!.text).not.toContain("secret_ciphertext");
    expect(queries[0]!.text).not.toContain("SELECT *");
  });

  it("returns conflict on unique violation", async () => {
    const { executor } = createFakeExecutor({ error: new Error("D1_ERROR: UNIQUE constraint failed") });
    const repo = createWebhookRepository(executor);
    const result = await repo.createEndpoint({
      id: "ep-001",
      orgId: ORG_ID,
      url: "https://example.com/webhook",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("gets an endpoint scoped by orgId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ENDPOINT_ROW] });
    const repo = createWebhookRepository(executor);
    const result = await repo.getEndpoint(ORG_ID, "ep-001");
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[0]).toBe(ORG_ID);
    expect(queries[0]!.params[1]).toBe("ep-001");
  });

  it("returns not_found for missing endpoint", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createWebhookRepository(executor);
    const result = await repo.getEndpoint(ORG_ID, "nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("lists endpoints with org scope filter", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ENDPOINT_ROW] });
    const repo = createWebhookRepository(executor);
    const result = await repo.listEndpoints(ORG_ID, { limit: 10, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toHaveLength(1);
    expect(queries[0]!.text).toContain("org_id = $1");
    expect(queries[0]!.params[0]).toBe(ORG_ID);
  });

  it("lists endpoints with project scope filter requiring orgId + projectId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createWebhookRepository(executor);
    await repo.listEndpoints(ORG_ID, { limit: 10, cursor: null }, PROJECT_ID);
    expect(queries[0]!.text).toContain("org_id = $1 AND project_id = $2");
    expect(queries[0]!.params[0]).toBe(ORG_ID);
    expect(queries[0]!.params[1]).toBe(PROJECT_ID);
  });

  it("supports cursor pagination in endpoint list", async () => {
    const rows = [
      { ...SAMPLE_ENDPOINT_ROW, id: "ep-a" },
      { ...SAMPLE_ENDPOINT_ROW, id: "ep-b" },
    ];
    const { executor } = createFakeExecutor({ rows });
    const repo = createWebhookRepository(executor);
    const result = await repo.listEndpoints(ORG_ID, { limit: 1, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.nextCursor).not.toBeNull();
    }
  });

  it("updates an endpoint by orgId + endpointId", async () => {
    const updatedRow = { ...SAMPLE_ENDPOINT_ROW, url: "https://new.example.com" };
    const { executor, queries } = createFakeExecutor({ rows: [updatedRow] });
    const repo = createWebhookRepository(executor);
    const result = await repo.updateEndpoint(ORG_ID, "ep-001", { url: "https://new.example.com" });
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[0]).toBe(ORG_ID);
    expect(queries[0]!.params[1]).toBe("ep-001");
  });

  it("returns not_found when updating a non-existent endpoint", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createWebhookRepository(executor);
    const result = await repo.updateEndpoint(ORG_ID, "ep-999", { url: "https://x.com" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("disables an endpoint with reason", async () => {
    const disabledRow = { ...SAMPLE_ENDPOINT_ROW, status: "disabled", disabled_reason: "Too many failures" };
    const { executor, queries } = createFakeExecutor({ rows: [disabledRow] });
    const repo = createWebhookRepository(executor);
    const result = await repo.disableEndpoint(ORG_ID, "ep-001", { reason: "Too many failures" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("disabled");
      expect(result.value.disabledReason).toBe("Too many failures");
    }
    expect(queries[0]!.text).toContain("status = 'disabled'");
    expect(queries[0]!.text).toContain("status = 'active'"); // WHERE guard
  });

  it("enables a disabled endpoint and clears disabled_reason / disabled_at", async () => {
    const activeRow = {
      ...SAMPLE_ENDPOINT_ROW,
      status: "active",
      disabled_reason: null,
      disabled_at: null,
    };
    const { executor, queries } = createFakeExecutor({ rows: [activeRow] });
    const repo = createWebhookRepository(executor);
    const result = await repo.enableEndpoint(ORG_ID, "ep-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("active");
      expect(result.value.disabledReason).toBeNull();
      expect(result.value.disabledAt).toBeNull();
    }
    const sql = queries[0]!.text;
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("disabled_reason = NULL");
    expect(sql).toContain("disabled_at = NULL");
    // WHERE guard must scope to disabled rows only (idempotent semantics
    // and explicit pending-exclusion).
    expect(sql).toContain("AND status = 'disabled'");
    // Must not expose secret_ciphertext on the public-read surface.
    expect(sql).not.toMatch(/RETURNING[\s\S]*?\bsecret_ciphertext\b/);
    // Params: only orgId + endpointId (no body fields).
    expect(queries[0]!.params).toEqual([ORG_ID, "ep-001"]);
  });

  it("returns not_found when enabling a missing or already-active endpoint", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createWebhookRepository(executor);
    const result = await repo.enableEndpoint(ORG_ID, "ep-missing");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("enableEndpoint surfaces internal errors as a safe envelope", async () => {
    const { executor } = createFakeExecutor({ error: new Error("PG down") });
    const repo = createWebhookRepository(executor);
    const result = await repo.enableEndpoint(ORG_ID, "ep-001");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal");
  });

  it("deletes an endpoint scoped by orgId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [{}], rowCount: 1 });
    const repo = createWebhookRepository(executor);
    const result = await repo.deleteEndpoint(ORG_ID, "ep-001");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.deleted).toBe(true);
    expect(queries[0]!.params[0]).toBe(ORG_ID);
  });

  it("returns not_found when deleting a missing endpoint", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createWebhookRepository(executor);
    const result = await repo.deleteEndpoint(ORG_ID, "nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("rotates endpoint secret (increments version)", async () => {
    const rotatedRow = { ...SAMPLE_ENDPOINT_ROW, secret_version: 2, secret_last_rotated_at: NOW.toISOString() };
    const { executor, queries } = createFakeExecutor({ rows: [rotatedRow] });
    const repo = createWebhookRepository(executor);
    const result = await repo.rotateEndpointSecret(ORG_ID, "ep-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.endpoint.secretVersion).toBe(2);
      expect(result.value.previousSecretVersion).toBeNull();
      expect(result.value.previousSecretExpiresAt).toBeNull();
    }
    expect(queries[0]!.text).toContain("secret_version = secret_version + 1");
    expect(queries[0]!.text).toContain("status = 'active'");
    // Must not return secret_ciphertext (current or previous) — public read surface
    expect(queries[0]!.text).not.toMatch(/RETURNING[\s\S]*?\bsecret_ciphertext\b/);
    expect(queries[0]!.text).not.toMatch(/RETURNING[\s\S]*?previous_secret_ciphertext/);
  });

  it("returns not_found when rotating secret on non-existent endpoint", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createWebhookRepository(executor);
    const result = await repo.rotateEndpointSecret(ORG_ID, "nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("rotate with grace window snapshots previous ciphertext, version, and sets expires_at", async () => {
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const rotatedRow = {
      ...SAMPLE_ENDPOINT_ROW,
      secret_version: 5,
      secret_last_rotated_at: NOW.toISOString(),
      previous_secret_version: 4,
      previous_secret_expires_at: futureExpiry,
    };
    const { executor, queries } = createFakeExecutor({ rows: [rotatedRow] });
    const repo = createWebhookRepository(executor);
    const result = await repo.rotateEndpointSecret(ORG_ID, "ep-001", {
      secretCiphertext: "new-encrypted-envelope",
      gracePeriodSeconds: 86400,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.endpoint.secretVersion).toBe(5);
      // Previous-secret snapshot must propagate to the result
      expect(result.value.previousSecretVersion).toBe(4);
      expect(result.value.previousSecretExpiresAt).toBe(new Date(futureExpiry).toISOString());
    }

    const sql = queries[0]!.text;
    // SQL must snapshot current secret_ciphertext + secret_version into previous_*
    expect(sql).toMatch(/previous_secret_ciphertext\s*=\s*secret_ciphertext/);
    expect(sql).toMatch(/previous_secret_version\s*=\s*secret_version/);
    // SQL must compute expires_at as now + the grace window in seconds. On
    // SQLite that is a strftime modifier, not an INTERVAL literal.
    expect(sql).toContain("previous_secret_expires_at");
    expect(sql).toContain("' || $4 || ' seconds'");
    // grace seconds and ciphertext both passed as parameters
    expect(queries[0]!.params).toContain(86400);
    expect(queries[0]!.params).toContain("new-encrypted-envelope");
    // Public read surface must NOT expose previous secret material
    expect(sql).not.toMatch(/RETURNING[\s\S]*?previous_secret_ciphertext/);
  });

  it("rotate without grace window clears any stale previous-secret snapshot", async () => {
    const rotatedRow = {
      ...SAMPLE_ENDPOINT_ROW,
      secret_version: 6,
      secret_last_rotated_at: NOW.toISOString(),
      previous_secret_version: null,
      previous_secret_expires_at: null,
    };
    const { executor, queries } = createFakeExecutor({ rows: [rotatedRow] });
    const repo = createWebhookRepository(executor);
    const result = await repo.rotateEndpointSecret(ORG_ID, "ep-001", {
      secretCiphertext: "new-envelope",
      // gracePeriodSeconds intentionally omitted
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.previousSecretVersion).toBeNull();
      expect(result.value.previousSecretExpiresAt).toBeNull();
    }
    const sql = queries[0]!.text;
    expect(sql).toMatch(/previous_secret_ciphertext\s*=\s*NULL/);
    expect(sql).toMatch(/previous_secret_version\s*=\s*NULL/);
    expect(sql).toMatch(/previous_secret_expires_at\s*=\s*NULL/);
  });
});

// ── Subscription tests ────────────────────────────────────

describe("WebhookRepository — Subscriptions", () => {
  it("creates a subscription with parameterized query", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SUBSCRIPTION_ROW] });
    const repo = createWebhookRepository(executor);
    const result = await repo.createSubscription({
      id: "sub-001",
      orgId: ORG_ID,
      endpointId: "ep-001",
      eventType: "project.created",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.eventType).toBe("project.created");
      expect(result.value.enabled).toBe(true);
      expect(result.value.projectId).toBeNull();
    }
    expect(queries[0]!.text).toContain("webhooks_webhook_subscriptions");
  });

  it("creates a project-scoped subscription with orgId + projectId", async () => {
    const row = { ...SAMPLE_SUBSCRIPTION_ROW, project_id: PROJECT_ID };
    const { executor, queries } = createFakeExecutor({ rows: [row] });
    const repo = createWebhookRepository(executor);
    await repo.createSubscription({
      id: "sub-002",
      orgId: ORG_ID,
      endpointId: "ep-001",
      projectId: PROJECT_ID,
      eventType: "member.added",
    });
    expect(queries[0]!.params[1]).toBe(ORG_ID);
    expect(queries[0]!.params[3]).toBe(PROJECT_ID);
  });

  it("returns conflict on duplicate subscription", async () => {
    const { executor } = createFakeExecutor({ error: new Error("D1_ERROR: UNIQUE constraint failed") });
    const repo = createWebhookRepository(executor);
    const result = await repo.createSubscription({
      id: "sub-001",
      orgId: ORG_ID,
      endpointId: "ep-001",
      eventType: "project.created",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("gets a subscription scoped by orgId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SUBSCRIPTION_ROW] });
    const repo = createWebhookRepository(executor);
    const result = await repo.getSubscription(ORG_ID, "sub-001");
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[0]).toBe(ORG_ID);
  });

  it("lists subscriptions scoped by orgId + endpointId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SUBSCRIPTION_ROW] });
    const repo = createWebhookRepository(executor);
    const result = await repo.listSubscriptions(ORG_ID, "ep-001", { limit: 10, cursor: null });
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("org_id = $1 AND endpoint_id = $2");
  });

  it("updates a subscription by orgId", async () => {
    const updatedRow = { ...SAMPLE_SUBSCRIPTION_ROW, enabled: false };
    const { executor, queries } = createFakeExecutor({ rows: [updatedRow] });
    const repo = createWebhookRepository(executor);
    const result = await repo.updateSubscription(ORG_ID, "sub-001", { enabled: false });
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[0]).toBe(ORG_ID);
  });

  it("returns not_found when updating non-existent subscription", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createWebhookRepository(executor);
    const result = await repo.updateSubscription(ORG_ID, "nope", { enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("deletes a subscription scoped by orgId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [{}], rowCount: 1 });
    const repo = createWebhookRepository(executor);
    const result = await repo.deleteSubscription(ORG_ID, "sub-001");
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[0]).toBe(ORG_ID);
  });
});

// ── Delivery attempt tests ────────────────────────────────

describe("WebhookRepository — Delivery Attempts", () => {
  it("creates a delivery attempt with parameterized query", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_DELIVERY_ROW] });
    const repo = createWebhookRepository(executor);
    const result = await repo.createDeliveryAttempt({
      id: "del-001",
      orgId: ORG_ID,
      endpointId: "ep-001",
      subscriptionId: "sub-001",
      eventId: "evt-001",
      eventType: "project.created",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("pending");
      expect(result.value.attemptNumber).toBe(1);
    }
    expect(queries[0]!.text).toContain("webhooks_webhook_delivery_attempts");
  });

  it("updates a delivery attempt by orgId + attemptId", async () => {
    const updatedRow = { ...SAMPLE_DELIVERY_ROW, status: "success", http_status_code: 200 };
    const { executor, queries } = createFakeExecutor({ rows: [updatedRow] });
    const repo = createWebhookRepository(executor);
    const result = await repo.updateDeliveryAttempt(ORG_ID, "del-001", {
      status: "success",
      httpStatusCode: 200,
      completedAt: NOW,
    });
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[0]).toBe(ORG_ID);
    expect(queries[0]!.params[1]).toBe("del-001");
  });

  it("returns not_found when updating non-existent delivery attempt", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createWebhookRepository(executor);
    const result = await repo.updateDeliveryAttempt(ORG_ID, "nope", { status: "failed" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("gets a delivery attempt scoped by orgId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_DELIVERY_ROW] });
    const repo = createWebhookRepository(executor);
    const result = await repo.getDeliveryAttempt(ORG_ID, "del-001");
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[0]).toBe(ORG_ID);
  });

  it("lists delivery attempts scoped by orgId + endpointId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_DELIVERY_ROW] });
    const repo = createWebhookRepository(executor);
    const result = await repo.listDeliveryAttempts(ORG_ID, "ep-001", { limit: 10, cursor: null });
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("org_id = $1 AND endpoint_id = $2");
  });

  it("supports cursor pagination in delivery attempt list", async () => {
    const rows = [
      { ...SAMPLE_DELIVERY_ROW, id: "del-a" },
      { ...SAMPLE_DELIVERY_ROW, id: "del-b" },
    ];
    const { executor } = createFakeExecutor({ rows });
    const repo = createWebhookRepository(executor);
    const result = await repo.listDeliveryAttempts(ORG_ID, "ep-001", { limit: 1, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.nextCursor).not.toBeNull();
    }
  });
});

// ── Secret safety invariants ──────────────────────────────

describe("WebhookRepository — Secret Safety", () => {
  it("endpoint read type does not contain plaintext secret fields", async () => {
    const { executor } = createFakeExecutor({ rows: [SAMPLE_ENDPOINT_ROW] });
    const repo = createWebhookRepository(executor);
    const result = await repo.getEndpoint(ORG_ID, "ep-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const val = result.value;
      expect("secret_ciphertext" in val).toBe(false);
      expect("secretCiphertext" in val).toBe(false);
      expect("signingSecret" in val).toBe(false);
      expect("signing_secret" in val).toBe(false);
      expect("plaintext" in val).toBe(false);
      expect("secret_hash" in val).toBe(false);
      expect("secretHash" in val).toBe(false);
    }
  });

  it("endpoint SELECT never uses SELECT *", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ENDPOINT_ROW] });
    const repo = createWebhookRepository(executor);
    await repo.getEndpoint(ORG_ID, "ep-001");
    expect(queries[0]!.text).not.toContain("SELECT *");
  });

  it("endpoint list never uses SELECT *", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createWebhookRepository(executor);
    await repo.listEndpoints(ORG_ID, { limit: 10, cursor: null });
    expect(queries[0]!.text).not.toContain("SELECT *");
  });

  it("rotate secret never returns secret_ciphertext", async () => {
    const rotatedRow = { ...SAMPLE_ENDPOINT_ROW, secret_version: 2 };
    const { executor, queries } = createFakeExecutor({ rows: [rotatedRow] });
    const repo = createWebhookRepository(executor);
    await repo.rotateEndpointSecret(ORG_ID, "ep-001", { secretCiphertext: "encrypted-data" });
    // Neither current nor previous ciphertext is exposed via RETURNING
    expect(queries[0]!.text).not.toMatch(/RETURNING[\s\S]*?\bsecret_ciphertext\b/);
    expect(queries[0]!.text).not.toMatch(/RETURNING[\s\S]*?previous_secret_ciphertext/);
  });

  it("getEndpointForDelivery surfaces previous-secret grace fields to the worker", async () => {
    const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const row = {
      id: "ep-001",
      org_id: ORG_ID,
      url: "https://example.com/webhook",
      status: "active",
      secret_ciphertext: "current-envelope",
      secret_version: 7,
      previous_secret_ciphertext: "previous-envelope",
      previous_secret_version: 6,
      previous_secret_expires_at: expiry,
    };
    const { executor } = createFakeExecutor({ rows: [row] });
    const repo = createWebhookRepository(executor);
    const result = await repo.getEndpointForDelivery(ORG_ID, "ep-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.secretCiphertext).toBe("current-envelope");
      expect(result.value.secretVersion).toBe(7);
      expect(result.value.previousSecretCiphertext).toBe("previous-envelope");
      expect(result.value.previousSecretVersion).toBe(6);
      expect(result.value.previousSecretExpiresAt).toBe(new Date(expiry).toISOString());
    }
  });
});

// ── Migration shape tests ─────────────────────────────────

describe("WebhookRepository — Migration Manifest", () => {
  it("manifest includes 080_webhooks_core with correct checksum format", async () => {
    // This test validates the manifest entry exists and checksum looks like SHA-256
    const { manifest } = await import("@saas/db/manifest");
    const entry = manifest.migrations.find((m: { id: string }) => m.id === "080_webhooks_core");
    expect(entry).toBeDefined();
    expect(entry!.context).toBe("webhooks");
    expect(entry!.path).toBe("080_webhooks_core/up.sql");
    expect(entry!.checksum).toMatch(/^[a-f0-9]{64}$/);
  });
});
