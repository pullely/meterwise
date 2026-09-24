/**
 * Tests for webhook delivery runtime — signing, dispatch, retry.
 */

import {
  dispatchNewEvents,
  retryFailedDeliveries,
  replayDeliveryAttempt,
  isWebhookLifecycleEvent,
  buildDeliveryLifecyclePayload,
  AUTO_DISABLE_FAILURE_THRESHOLD,
} from "@webhooks-worker/delivery";
import { createEncryptionAdapter } from "@webhooks-worker/encryption";
import type {
  WebhookRepository,
  WebhookDeliveryAttempt,
  EndpointForDelivery,
  MatchedSubscription,
  DispatchCursor,
  CreateDeliveryAttemptInput,
  UpdateDeliveryAttemptInput,
} from "@saas/db/webhooks";
import type { EventsRepository, StoredEvent, StoredAuditEntry, EventsResult, AppendEventInput, AppendEventWithAuditInput } from "@saas/db/events";

// ── Test constants ──────────────────────────────────────────

const TEST_ORG_UUID = "11111111-1111-1111-1111-111111111111";
const TEST_ENDPOINT_UUID = "44444444-4444-4444-4444-444444444444";
const TEST_SUBSCRIPTION_UUID = "55555555-5555-5555-5555-555555555555";
const TEST_EVENT_ID = "evt_test_001";
const TEST_SIGNING_SECRET = "whsec_test_signing_secret_1234567890";
const TEST_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeStoredEvent(overrides?: Partial<StoredEvent>): StoredEvent {
  return {
    id: TEST_EVENT_ID,
    type: "project.created",
    version: 1,
    source: "projects-worker",
    occurredAt: new Date("2026-05-29T10:00:00Z"),
    actorType: "user",
    actorId: "usr_abc",
    actorSessionId: null,
    actorIp: null,
    orgId: TEST_ORG_UUID,
    projectId: null,
    environmentId: null,
    subjectKind: "project",
    subjectId: "prj_xyz",
    subjectName: "My Project",
    requestId: "req_test",
    correlationId: null,
    causationId: null,
    idempotencyKey: null,
    payload: { name: "My Project" },
    redactPaths: [],
    createdAt: new Date("2026-05-29T10:00:00Z"),
    ...overrides,
  };
}

// ── Mock repos ──────────────────────────────────────────────

interface MockWebhookRepo extends WebhookRepository {
  _createdAttempts: CreateDeliveryAttemptInput[];
  _updatedAttempts: Array<{ orgId: string; attemptId: string; input: UpdateDeliveryAttemptInput }>;
  _advancedCursors: Array<{ orgId: string; lastEventId: string; lastOccurredAt: string }>;
  _disabledEndpoints: Array<{ orgId: string; endpointId: string; reason: string }>;
  _consecutiveFailures: number;
}

function createMockWebhookRepo(overrides?: {
  activeOrgIds?: string[];
  matchingSubs?: MatchedSubscription[];
  endpoint?: EndpointForDelivery | null;
  cursor?: DispatchCursor;
  retryable?: WebhookDeliveryAttempt[];
  consecutiveFailures?: number;
}): MockWebhookRepo {
  const created: CreateDeliveryAttemptInput[] = [];
  const updated: Array<{ orgId: string; attemptId: string; input: UpdateDeliveryAttemptInput }> = [];
  const advanced: Array<{ orgId: string; lastEventId: string; lastOccurredAt: string }> = [];
  const disabled: Array<{ orgId: string; endpointId: string; reason: string }> = [];

  return {
    _createdAttempts: created,
    _updatedAttempts: updated,
    _advancedCursors: advanced,
    _disabledEndpoints: disabled,
    _consecutiveFailures: overrides?.consecutiveFailures ?? 0,

    // Delivery runtime methods
    async listActiveOrgIds() {
      return { ok: true, value: overrides?.activeOrgIds ?? [TEST_ORG_UUID] };
    },
    async getDispatchCursor(orgId: string) {
      return {
        ok: true,
        value: overrides?.cursor ?? {
          orgId,
          subscriberLane: "webhooks",
          lastEventId: null,
          lastOccurredAt: null,
          updatedAt: new Date(0),
        },
      };
    },
    async advanceDispatchCursor(orgId: string, lastEventId: string, lastOccurredAt: string) {
      advanced.push({ orgId, lastEventId, lastOccurredAt });
      return {
        ok: true,
        value: { orgId, subscriberLane: "webhooks", lastEventId, lastOccurredAt, updatedAt: new Date() },
      };
    },
    async findMatchingSubscriptions() {
      return {
        ok: true,
        value: overrides?.matchingSubs ?? [{
          id: TEST_SUBSCRIPTION_UUID,
          orgId: TEST_ORG_UUID,
          endpointId: TEST_ENDPOINT_UUID,
          projectId: null,
          eventType: "project.created",
        }],
      };
    },
    async getEndpointForDelivery() {
      const ep = overrides?.endpoint;
      if (ep === null) return { ok: false as const, error: { kind: "not_found" as const } };
      return {
        ok: true,
        value: ep ?? {
          id: TEST_ENDPOINT_UUID,
          orgId: TEST_ORG_UUID,
          url: "https://example.com/webhook",
          status: "active" as const,
          secretCiphertext: null,
          secretVersion: 1,
          previousSecretCiphertext: null,
          previousSecretVersion: null,
          previousSecretExpiresAt: null,
        },
      };
    },
    async createDeliveryAttempt(input: CreateDeliveryAttemptInput) {
      created.push(input);
      const attempt: WebhookDeliveryAttempt = {
        id: input.id,
        orgId: input.orgId,
        endpointId: input.endpointId,
        subscriptionId: input.subscriptionId,
        eventId: input.eventId,
        eventType: input.eventType,
        status: "pending",
        attemptNumber: 1,
        httpStatusCode: null,
        failureReason: null,
        idempotencyKey: input.idempotencyKey ?? null,
        nextRetryAt: null,
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return { ok: true, value: attempt };
    },
    async updateDeliveryAttempt(orgId: string, attemptId: string, input: UpdateDeliveryAttemptInput) {
      updated.push({ orgId, attemptId, input });
      return {
        ok: true,
        value: {
          id: attemptId,
          orgId,
          endpointId: TEST_ENDPOINT_UUID,
          subscriptionId: TEST_SUBSCRIPTION_UUID,
          eventId: TEST_EVENT_ID,
          eventType: "project.created",
          status: input.status,
          attemptNumber: input.attemptNumber ?? 1,
          httpStatusCode: input.httpStatusCode ?? null,
          failureReason: input.failureReason ?? null,
          idempotencyKey: null,
          nextRetryAt: input.nextRetryAt ?? null,
          completedAt: input.completedAt ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };
    },
    async listRetryableDeliveries() {
      return { ok: true, value: overrides?.retryable ?? [] };
    },

    // Stubs for non-delivery methods (not exercised in delivery tests)
    async createEndpoint() { throw new Error("not called"); },
    async getEndpoint() { throw new Error("not called"); },
    async listEndpoints() { throw new Error("not called"); },
    async updateEndpoint() { throw new Error("not called"); },
    async disableEndpoint(orgId: string, endpointId: string, input: { reason?: string }) {
      disabled.push({ orgId, endpointId, reason: input.reason ?? "" });
      return {
        ok: true,
        value: {
          id: endpointId,
          orgId,
          projectId: null,
          url: "https://example.com/webhook",
          name: null,
          description: null,
          status: "disabled" as const,
          disabledReason: input.reason ?? null,
          disabledAt: new Date(),
          secretVersion: 1,
          secretLastRotatedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      };
    },
    async deleteEndpoint() { throw new Error("not called"); },
    async rotateEndpointSecret() { throw new Error("not called"); },
    async createSubscription() { throw new Error("not called"); },
    async getSubscription() { throw new Error("not called"); },
    async listSubscriptions() { throw new Error("not called"); },
    async updateSubscription() { throw new Error("not called"); },
    async deleteSubscription() { throw new Error("not called"); },
    async getDeliveryAttempt() { throw new Error("not called"); },
    async listDeliveryAttempts() { throw new Error("not called"); },
    async countConsecutiveEndpointFailures() {
      return { ok: true, value: overrides?.consecutiveFailures ?? 0 };
    },
  } as unknown as MockWebhookRepo;
}

interface MockEventsRepo extends EventsRepository {
  _appendedEvents: AppendEventInput[];
  _appendedEventsWithAudit: AppendEventWithAuditInput[];
}

function createMockEventsRepo(events: StoredEvent[] = []): MockEventsRepo {
  const appendedEvents: AppendEventInput[] = [];
  const appendedEventsWithAudit: AppendEventWithAuditInput[] = [];
  return {
    _appendedEvents: appendedEvents,
    _appendedEventsWithAudit: appendedEventsWithAudit,
    async queryEventsByOrg() {
      return { ok: true, value: events } as EventsResult<StoredEvent[]>;
    },
    async appendEvent(input: AppendEventInput) {
      appendedEvents.push(input);
      return { ok: true, value: { ...input, createdAt: new Date(), redactPaths: input.redactPaths ?? [], actorSessionId: null, actorIp: null, projectId: null, environmentId: null, subjectName: null, correlationId: null, causationId: input.causationId ?? null, idempotencyKey: input.idempotencyKey ?? null } } as EventsResult<StoredEvent>;
    },
    async appendEventWithAudit(input: AppendEventWithAuditInput) {
      appendedEventsWithAudit.push(input);
      return { ok: true, value: { event: { ...input.event, createdAt: new Date(), redactPaths: [], actorSessionId: null, actorIp: null, projectId: null, environmentId: null, subjectName: null, correlationId: null, causationId: null, idempotencyKey: null }, audit: { id: input.audit.id, eventId: input.event.id, orgId: input.event.orgId, actorType: input.event.actorType, actorId: input.event.actorId, eventType: input.event.type, eventVersion: input.event.version, source: input.event.source, subjectKind: input.event.subjectKind, subjectId: input.event.subjectId, subjectName: null, projectId: null, environmentId: null, category: input.audit.category ?? "webhooks", description: input.audit.description ?? "", occurredAt: input.event.occurredAt, requestId: input.event.requestId, correlationId: null, payload: input.event.payload, redactPaths: [], createdAt: new Date() } } } as EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>;
    },
    async queryAuditByOrg() { throw new Error("not called"); },
    async queryAuditByTarget() { throw new Error("not called"); },
  } as unknown as MockEventsRepo;
}

// ── Encryption tests ────────────────────────────────────────

describe("encryption adapter — encrypt/decrypt round-trip", () => {
  it("encrypts and decrypts to original plaintext", async () => {
    const adapter = await createEncryptionAdapter(TEST_ENCRYPTION_KEY);
    expect(adapter).not.toBeNull();

    const plaintext = TEST_SIGNING_SECRET;
    const envelope = await adapter!.encrypt(plaintext);

    expect(envelope.alg).toBe("AES-256-GCM");
    expect(envelope.v).toBe(1);
    expect(envelope.iv).toBeTruthy();
    expect(envelope.ct).toBeTruthy();

    const decrypted = await adapter!.decrypt(envelope);
    expect(decrypted).toBe(plaintext);
  });

  it("different encryptions produce different ciphertexts (random IV)", async () => {
    const adapter = await createEncryptionAdapter(TEST_ENCRYPTION_KEY);
    const e1 = await adapter!.encrypt("same");
    const e2 = await adapter!.encrypt("same");
    expect(e1.ct).not.toBe(e2.ct);
    expect(e1.iv).not.toBe(e2.iv);
  });

  it("returns null for invalid key", async () => {
    const adapter = await createEncryptionAdapter("tooshort");
    expect(adapter).toBeNull();
  });

  it("returns null for undefined key", async () => {
    const adapter = await createEncryptionAdapter(undefined);
    expect(adapter).toBeNull();
  });
});

// ── dispatchNewEvents tests ─────────────────────────────────

describe("dispatchNewEvents", () => {
  // Use a mock fetcher to intercept outgoing HTTP calls
  let fetchCalls: Array<{ url: string; init: RequestInit }>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      fetchCalls.push({ url, init: init ?? {} });
      return new Response("OK", { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("dispatches event to matching subscription and advances cursor", async () => {
    const event = makeStoredEvent();
    const webhookRepo = createMockWebhookRepo();
    const eventsRepo = createMockEventsRepo([event]);

    const result = await dispatchNewEvents({
      webhookRepo,
      eventsRepo,
      encryption: null,
    });

    expect(result.dispatched).toBe(1);
    expect(result.errors).toBe(0);

    // Verify delivery attempt was created
    expect(webhookRepo._createdAttempts).toHaveLength(1);
    expect(webhookRepo._createdAttempts[0]!.eventId).toBe(TEST_EVENT_ID);
    expect(webhookRepo._createdAttempts[0]!.subscriptionId).toBe(TEST_SUBSCRIPTION_UUID);

    // Verify HTTP was called
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://example.com/webhook");

    // Verify cursor was advanced
    expect(webhookRepo._advancedCursors).toHaveLength(1);
    expect(webhookRepo._advancedCursors[0]!.lastEventId).toBe(TEST_EVENT_ID);
  });

  it("skips when no active orgs", async () => {
    const webhookRepo = createMockWebhookRepo({ activeOrgIds: [] });
    const eventsRepo = createMockEventsRepo();

    const result = await dispatchNewEvents({
      webhookRepo,
      eventsRepo,
      encryption: null,
    });

    expect(result.dispatched).toBe(0);
    expect(result.errors).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("skips when no new events", async () => {
    const webhookRepo = createMockWebhookRepo();
    const eventsRepo = createMockEventsRepo([]);

    const result = await dispatchNewEvents({
      webhookRepo,
      eventsRepo,
      encryption: null,
    });

    expect(result.dispatched).toBe(0);
    expect(webhookRepo._advancedCursors).toHaveLength(0);
  });

  it("skips when no matching subscriptions", async () => {
    const event = makeStoredEvent();
    const webhookRepo = createMockWebhookRepo({ matchingSubs: [] });
    const eventsRepo = createMockEventsRepo([event]);

    const result = await dispatchNewEvents({
      webhookRepo,
      eventsRepo,
      encryption: null,
    });

    expect(result.dispatched).toBe(0);
    expect(webhookRepo._createdAttempts).toHaveLength(0);
    // Cursor should still advance past the event
    expect(webhookRepo._advancedCursors).toHaveLength(1);
  });

  it("includes HMAC signature when endpoint has encrypted secret", async () => {
    const encryption = await createEncryptionAdapter(TEST_ENCRYPTION_KEY);
    const envelope = await encryption!.encrypt(TEST_SIGNING_SECRET);
    const secretCiphertext = JSON.stringify(envelope);

    const endpoint: EndpointForDelivery = {
      id: TEST_ENDPOINT_UUID,
      orgId: TEST_ORG_UUID,
      url: "https://example.com/webhook",
      status: "active",
      secretCiphertext,
      secretVersion: 1,
      previousSecretCiphertext: null,
      previousSecretVersion: null,
      previousSecretExpiresAt: null,
    };

    const event = makeStoredEvent();
    const webhookRepo = createMockWebhookRepo({ endpoint });
    const eventsRepo = createMockEventsRepo([event]);

    await dispatchNewEvents({
      webhookRepo,
      eventsRepo,
      encryption,
    });

    expect(fetchCalls).toHaveLength(1);
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers["X-Webhook-Timestamp"]).toBeTruthy();
  });

  // ── Dual-signature grace window (B5: secret rotation grace) ────────────

  it("emits dual signatures (X-Webhook-Signature + X-Webhook-Signature-Previous) during grace window", async () => {
    const encryption = await createEncryptionAdapter(TEST_ENCRYPTION_KEY);
    const newEnvelope = await encryption!.encrypt(TEST_SIGNING_SECRET);
    const PREV_SECRET = "previous-rotation-secret-grace-window";
    const prevEnvelope = await encryption!.encrypt(PREV_SECRET);

    // Grace window expires 1 hour from now → still active
    const expiresInFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const endpoint: EndpointForDelivery = {
      id: TEST_ENDPOINT_UUID,
      orgId: TEST_ORG_UUID,
      url: "https://example.com/webhook",
      status: "active",
      secretCiphertext: JSON.stringify(newEnvelope),
      secretVersion: 2,
      previousSecretCiphertext: JSON.stringify(prevEnvelope),
      previousSecretVersion: 1,
      previousSecretExpiresAt: expiresInFuture,
    };

    const event = makeStoredEvent();
    const webhookRepo = createMockWebhookRepo({ endpoint });
    const eventsRepo = createMockEventsRepo([event]);

    await dispatchNewEvents({ webhookRepo, eventsRepo, encryption });

    expect(fetchCalls).toHaveLength(1);
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    const primary = headers["X-Webhook-Signature"];
    const previous = headers["X-Webhook-Signature-Previous"];
    expect(primary).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(previous).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Different secrets must produce distinct signatures
    expect(primary).not.toBe(previous);
    // No raw secret material leaks into headers
    expect(JSON.stringify(headers)).not.toContain(TEST_SIGNING_SECRET);
    expect(JSON.stringify(headers)).not.toContain(PREV_SECRET);
  });

  it("emits only primary signature once grace window has expired", async () => {
    const encryption = await createEncryptionAdapter(TEST_ENCRYPTION_KEY);
    const newEnvelope = await encryption!.encrypt(TEST_SIGNING_SECRET);
    const prevEnvelope = await encryption!.encrypt("previous-rotation-secret-expired");

    // Grace window expired 1 hour ago
    const expiresInPast = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const endpoint: EndpointForDelivery = {
      id: TEST_ENDPOINT_UUID,
      orgId: TEST_ORG_UUID,
      url: "https://example.com/webhook",
      status: "active",
      secretCiphertext: JSON.stringify(newEnvelope),
      secretVersion: 3,
      previousSecretCiphertext: JSON.stringify(prevEnvelope),
      previousSecretVersion: 2,
      previousSecretExpiresAt: expiresInPast,
    };

    const event = makeStoredEvent();
    const webhookRepo = createMockWebhookRepo({ endpoint });
    const eventsRepo = createMockEventsRepo([event]);

    await dispatchNewEvents({ webhookRepo, eventsRepo, encryption });

    expect(fetchCalls).toHaveLength(1);
    const headers = fetchCalls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers["X-Webhook-Signature-Previous"]).toBeUndefined();
  });

  it("handles non-2xx response with retry scheduling", async () => {
    globalThis.fetch = async () => new Response("Internal Server Error", { status: 500 });

    const event = makeStoredEvent();
    const webhookRepo = createMockWebhookRepo();
    const eventsRepo = createMockEventsRepo([event]);

    const result = await dispatchNewEvents({
      webhookRepo,
      eventsRepo,
      encryption: null,
    });

    expect(result.dispatched).toBe(1); // still counted as dispatched (attempted)
    expect(webhookRepo._updatedAttempts).toHaveLength(1);
    const update = webhookRepo._updatedAttempts[0]!;
    expect(update.input.status).toBe("retrying");
    expect(update.input.httpStatusCode).toBe(500);
    expect(update.input.nextRetryAt).toBeTruthy();
  });

  it("marks as failed when endpoint is disabled", async () => {
    const endpoint: EndpointForDelivery = {
      id: TEST_ENDPOINT_UUID,
      orgId: TEST_ORG_UUID,
      url: "https://example.com/webhook",
      status: "disabled",
      secretCiphertext: null,
      secretVersion: 1,
      previousSecretCiphertext: null,
      previousSecretVersion: null,
      previousSecretExpiresAt: null,
    };

    const event = makeStoredEvent();
    const webhookRepo = createMockWebhookRepo({ endpoint });
    const eventsRepo = createMockEventsRepo([event]);

    await dispatchNewEvents({
      webhookRepo,
      eventsRepo,
      encryption: null,
    });

    expect(webhookRepo._updatedAttempts).toHaveLength(1);
    expect(webhookRepo._updatedAttempts[0]!.input.status).toBe("failed");
    expect(webhookRepo._updatedAttempts[0]!.input.failureReason).toBe("endpoint_disabled");
    expect(fetchCalls).toHaveLength(0); // no HTTP call for disabled endpoint
  });
});

// ── retryFailedDeliveries tests ─────────────────────────────

describe("retryFailedDeliveries", () => {
  let fetchCalls: Array<{ url: string; init: RequestInit }>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      fetchCalls.push({ url, init: init ?? {} });
      return new Response("OK", { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("retries delivery attempts that are due", async () => {
    const retryable: WebhookDeliveryAttempt = {
      id: "retry-attempt-1",
      orgId: TEST_ORG_UUID,
      endpointId: TEST_ENDPOINT_UUID,
      subscriptionId: TEST_SUBSCRIPTION_UUID,
      eventId: TEST_EVENT_ID,
      eventType: "project.created",
      status: "retrying",
      attemptNumber: 2,
      httpStatusCode: 500,
      failureReason: "HTTP 500",
      idempotencyKey: null,
      nextRetryAt: new Date(Date.now() - 1000),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const webhookRepo = createMockWebhookRepo({ retryable: [retryable] });
    const eventsRepo = createMockEventsRepo();

    const result = await retryFailedDeliveries({
      webhookRepo,
      eventsRepo,
      encryption: null,
    });

    expect(result.retried).toBe(1);
    expect(result.errors).toBe(0);
    expect(fetchCalls).toHaveLength(1);
    expect(webhookRepo._updatedAttempts).toHaveLength(1);
    expect(webhookRepo._updatedAttempts[0]!.input.status).toBe("success");
  });

  it("returns zero when no retryable deliveries", async () => {
    const webhookRepo = createMockWebhookRepo({ retryable: [] });
    const eventsRepo = createMockEventsRepo();

    const result = await retryFailedDeliveries({
      webhookRepo,
      eventsRepo,
      encryption: null,
    });

    expect(result.retried).toBe(0);
    expect(result.errors).toBe(0);
  });
});

// ── replayDeliveryAttempt (manual replay) ───────────────────

describe("replayDeliveryAttempt", () => {
  let fetchCalls: Array<{ url: string; init: RequestInit }>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      fetchCalls.push({ url, init: init ?? {} });
      return new Response("OK", { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function originalAttempt(
    over: Partial<WebhookDeliveryAttempt> = {},
  ): WebhookDeliveryAttempt {
    return {
      id: "whd_original",
      orgId: TEST_ORG_UUID,
      endpointId: TEST_ENDPOINT_UUID,
      subscriptionId: TEST_SUBSCRIPTION_UUID,
      eventId: TEST_EVENT_ID,
      eventType: "project.created",
      status: "failed",
      attemptNumber: 3,
      httpStatusCode: 500,
      failureReason: "HTTP 500",
      idempotencyKey: `${TEST_SUBSCRIPTION_UUID}:${TEST_EVENT_ID}:1`,
      nextRetryAt: null,
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
  }

  it("creates a fresh attempt and delivers through the same chokepoint", async () => {
    const webhookRepo = createMockWebhookRepo();
    // Make getDeliveryAttempt return the freshly-updated success row.
    (webhookRepo as unknown as { getDeliveryAttempt: unknown }).getDeliveryAttempt =
      async (orgId: string, attemptId: string) => ({
        ok: true,
        value: { ...originalAttempt(), id: attemptId, orgId, status: "success", httpStatusCode: 200 },
      });
    const event = makeStoredEvent();
    const eventsRepo = createMockEventsRepo([event]);

    const result = await replayDeliveryAttempt(
      { webhookRepo, eventsRepo, encryption: null },
      originalAttempt(),
      event,
    );

    expect(result.ok).toBe(true);
    // A brand-new attempt was created (fresh uuid, not the original id).
    expect(webhookRepo._createdAttempts).toHaveLength(1);
    const created = webhookRepo._createdAttempts[0]!;
    expect(created.id).not.toBe("whd_original");
    expect(created.eventId).toBe(TEST_EVENT_ID);
    expect(created.subscriptionId).toBe(TEST_SUBSCRIPTION_UUID);
    // Replay-distinct idempotency key — never collides with dispatch `:1`.
    expect(created.idempotencyKey).toMatch(
      new RegExp(`^${TEST_SUBSCRIPTION_UUID}:${TEST_EVENT_ID}:replay:`),
    );
    expect(created.idempotencyKey).not.toBe(`${TEST_SUBSCRIPTION_UUID}:${TEST_EVENT_ID}:1`);
    // Delivery happened through deliverAttempt → one HTTP POST.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://example.com/webhook");
  });

  it("resends the FULL original payload (not data:{}) when the event is rehydrated", async () => {
    const webhookRepo = createMockWebhookRepo();
    (webhookRepo as unknown as { getDeliveryAttempt: unknown }).getDeliveryAttempt =
      async () => ({ ok: false, error: { kind: "not_found" } });
    const event = makeStoredEvent({ payload: { name: "My Project", extra: 42 } });
    const eventsRepo = createMockEventsRepo([event]);

    await replayDeliveryAttempt(
      { webhookRepo, eventsRepo, encryption: null },
      originalAttempt(),
      event,
    );

    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(fetchCalls[0]!.init.body as string);
    expect(body.data).toEqual({ name: "My Project", extra: 42 });
    expect(body.id).toBe(TEST_EVENT_ID);
    expect(body.type).toBe("project.created");
  });

  it("takes the endpoint_disabled terminal path for a disabled endpoint", async () => {
    const endpoint: EndpointForDelivery = {
      id: TEST_ENDPOINT_UUID,
      orgId: TEST_ORG_UUID,
      url: "https://example.com/webhook",
      status: "disabled",
      secretCiphertext: null,
      secretVersion: 1,
      previousSecretCiphertext: null,
      previousSecretVersion: null,
      previousSecretExpiresAt: null,
    };
    const webhookRepo = createMockWebhookRepo({ endpoint });
    (webhookRepo as unknown as { getDeliveryAttempt: unknown }).getDeliveryAttempt =
      async (orgId: string, attemptId: string) => ({
        ok: true,
        value: { ...originalAttempt(), id: attemptId, status: "failed", failureReason: "endpoint_disabled" },
      });
    const event = makeStoredEvent();
    const eventsRepo = createMockEventsRepo([event]);

    await replayDeliveryAttempt(
      { webhookRepo, eventsRepo, encryption: null },
      originalAttempt(),
      event,
    );

    // No HTTP call — disabled endpoint short-circuits before fetch.
    expect(fetchCalls).toHaveLength(0);
    expect(webhookRepo._updatedAttempts).toHaveLength(1);
    expect(webhookRepo._updatedAttempts[0]!.input.status).toBe("failed");
    expect(webhookRepo._updatedAttempts[0]!.input.failureReason).toBe("endpoint_disabled");
  });

  it("returns create_failed when the initial insert fails", async () => {
    const webhookRepo = createMockWebhookRepo();
    (webhookRepo as unknown as { createDeliveryAttempt: unknown }).createDeliveryAttempt =
      async () => ({ ok: false, error: { kind: "insert_failed" } });
    const event = makeStoredEvent();
    const eventsRepo = createMockEventsRepo([event]);

    const result = await replayDeliveryAttempt(
      { webhookRepo, eventsRepo, encryption: null },
      originalAttempt(),
      event,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("create_failed");
    expect(fetchCalls).toHaveLength(0);
  });

  it("still delivers with data:{} when the original event is gone (event=null)", async () => {
    const webhookRepo = createMockWebhookRepo();
    (webhookRepo as unknown as { getDeliveryAttempt: unknown }).getDeliveryAttempt =
      async (orgId: string, attemptId: string) => ({
        ok: true,
        value: { ...originalAttempt(), id: attemptId, status: "success" },
      });
    const eventsRepo = createMockEventsRepo([]);

    const result = await replayDeliveryAttempt(
      { webhookRepo, eventsRepo, encryption: null },
      originalAttempt(),
      null,
    );

    expect(result.ok).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    const body = JSON.parse(fetchCalls[0]!.init.body as string);
    expect(body.data).toEqual({});
  });
});

// ── Webhook payload structure tests ─────────────────────────

describe("delivery payload structure", () => {
  let lastBody: string;
  let lastHeaders: Record<string, string>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    lastBody = "";
    lastHeaders = {};
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      lastBody = init?.body as string ?? "";
      lastHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response("OK", { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends correct JSON payload with event data", async () => {
    const event = makeStoredEvent({ payload: { foo: "bar" } });
    const webhookRepo = createMockWebhookRepo();
    const eventsRepo = createMockEventsRepo([event]);

    await dispatchNewEvents({
      webhookRepo,
      eventsRepo,
      encryption: null,
    });

    const parsed = JSON.parse(lastBody);
    expect(parsed.id).toBe(TEST_EVENT_ID);
    expect(parsed.type).toBe("project.created");
    expect(parsed.data).toEqual({ foo: "bar" });
    expect(parsed.occurred_at).toBeTruthy();
  });

  it("includes required headers", async () => {
    const event = makeStoredEvent();
    const webhookRepo = createMockWebhookRepo();
    const eventsRepo = createMockEventsRepo([event]);

    await dispatchNewEvents({
      webhookRepo,
      eventsRepo,
      encryption: null,
    });

    expect(lastHeaders["Content-Type"]).toBe("application/json");
    expect(lastHeaders["User-Agent"]).toBe("Meterwise-Webhooks/1.0");
    expect(lastHeaders["X-Webhook-ID"]).toBeTruthy();
    expect(lastHeaders["X-Webhook-Timestamp"]).toBeTruthy();
  });
});

// ── Delivery lifecycle event tests ───────────────────────────

describe("delivery lifecycle events", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("emits webhook.delivery_succeeded on successful delivery", async () => {
    globalThis.fetch = async () => new Response("OK", { status: 200 });

    const event = makeStoredEvent();
    const webhookRepo = createMockWebhookRepo();
    const eventsRepo = createMockEventsRepo([event]);

    await dispatchNewEvents({ webhookRepo, eventsRepo, encryption: null });

    expect(eventsRepo._appendedEvents).toHaveLength(1);
    expect(eventsRepo._appendedEvents[0]!.type).toBe("webhook.delivery_succeeded");
    expect(eventsRepo._appendedEvents[0]!.source).toBe("webhooks-worker");
    expect(eventsRepo._appendedEvents[0]!.actorType).toBe("system");
  });

  it("emits webhook.delivery_failed on terminal failure (retry exhausted)", async () => {
    globalThis.fetch = async () => new Response("Error", { status: 500 });

    // Attempt at max retries (attemptNumber >= MAX_RETRIES=5 → no retry → terminal)
    const retryable: WebhookDeliveryAttempt = {
      id: "terminal-fail-1",
      orgId: TEST_ORG_UUID,
      endpointId: TEST_ENDPOINT_UUID,
      subscriptionId: TEST_SUBSCRIPTION_UUID,
      eventId: TEST_EVENT_ID,
      eventType: "project.created",
      status: "retrying",
      attemptNumber: 5, // At MAX_RETRIES, no more retries
      httpStatusCode: 500,
      failureReason: "HTTP 500",
      idempotencyKey: null,
      nextRetryAt: new Date(Date.now() - 1000),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const webhookRepo = createMockWebhookRepo({ retryable: [retryable] });
    const eventsRepo = createMockEventsRepo();

    await retryFailedDeliveries({ webhookRepo, eventsRepo, encryption: null });

    // Should emit webhook.delivery_failed
    const failEvents = eventsRepo._appendedEvents.filter(e => e.type === "webhook.delivery_failed");
    expect(failEvents).toHaveLength(1);
    expect(failEvents[0]!.subjectKind).toBe("webhook_delivery_attempt");
    expect(failEvents[0]!.causationId).toBe(TEST_EVENT_ID);
  });

  it("success lifecycle event payload contains only safe metadata", async () => {
    globalThis.fetch = async () => new Response("OK", { status: 200 });

    const event = makeStoredEvent();
    const webhookRepo = createMockWebhookRepo();
    const eventsRepo = createMockEventsRepo([event]);

    await dispatchNewEvents({ webhookRepo, eventsRepo, encryption: null });

    const lifecycleEvent = eventsRepo._appendedEvents[0]!;
    const payload = lifecycleEvent.payload;

    // Must have safe fields
    expect(payload).toHaveProperty("delivery_attempt_id");
    expect(payload).toHaveProperty("endpoint_id");
    expect(payload).toHaveProperty("subscription_id");
    expect(payload).toHaveProperty("source_event_id");
    expect(payload).toHaveProperty("source_event_type");
    expect(payload).toHaveProperty("attempt_number");

    // Must NOT have secret/unsafe fields
    expect(payload).not.toHaveProperty("secret_ciphertext");
    expect(payload).not.toHaveProperty("signing_secret");
    expect(payload).not.toHaveProperty("response_body");
    expect(payload).not.toHaveProperty("stack_trace");
    expect(payload).not.toHaveProperty("bearer_token");
  });

  it("lifecycle event append failure does not cause duplicate delivery", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async () => {
      fetchCallCount++;
      return new Response("OK", { status: 200 });
    };

    const event = makeStoredEvent();
    const webhookRepo = createMockWebhookRepo();
    const eventsRepo = createMockEventsRepo([event]);
    // Make appendEvent throw to simulate failure
    eventsRepo.appendEvent = async () => { throw new Error("DB failure"); };

    const result = await dispatchNewEvents({ webhookRepo, eventsRepo, encryption: null });

    // Delivery should still succeed despite lifecycle event failure
    expect(result.dispatched).toBe(1);
    expect(fetchCallCount).toBe(1); // Only one HTTP call, no duplicate
    expect(webhookRepo._updatedAttempts[0]!.input.status).toBe("success");
  });
});

// ── Recursion guard tests ────────────────────────────────────

describe("webhook lifecycle event recursion prevention", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string }>;

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      fetchCalls.push({ url });
      return new Response("OK", { status: 200 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("isWebhookLifecycleEvent correctly identifies lifecycle event types", () => {
    expect(isWebhookLifecycleEvent("webhook.delivery_succeeded")).toBe(true);
    expect(isWebhookLifecycleEvent("webhook.delivery_failed")).toBe(true);
    expect(isWebhookLifecycleEvent("webhook.disabled")).toBe(true);
    expect(isWebhookLifecycleEvent("project.created")).toBe(false);
    expect(isWebhookLifecycleEvent("webhook.created")).toBe(false);
    expect(isWebhookLifecycleEvent("webhook_endpoint.created")).toBe(false);
  });

  it("does not deliver webhook lifecycle events to subscriptions (prevents recursion)", async () => {
    // Create a lifecycle event that would match a wildcard subscription
    const lifecycleEvent = makeStoredEvent({
      id: "evt_lifecycle_1",
      type: "webhook.delivery_succeeded",
    });

    const webhookRepo = createMockWebhookRepo({
      matchingSubs: [{
        id: TEST_SUBSCRIPTION_UUID,
        orgId: TEST_ORG_UUID,
        endpointId: TEST_ENDPOINT_UUID,
        projectId: null,
        eventType: "*", // Wildcard — would match everything without the guard
      }],
    });
    const eventsRepo = createMockEventsRepo([lifecycleEvent]);

    const result = await dispatchNewEvents({ webhookRepo, eventsRepo, encryption: null });

    // No delivery attempts should be created for lifecycle events
    expect(webhookRepo._createdAttempts).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
    expect(result.dispatched).toBe(0);

    // Cursor should still advance past the lifecycle event
    expect(webhookRepo._advancedCursors).toHaveLength(1);
    expect(webhookRepo._advancedCursors[0]!.lastEventId).toBe("evt_lifecycle_1");
  });

  it("does not deliver webhook.disabled events", async () => {
    const disabledEvent = makeStoredEvent({
      id: "evt_disabled_1",
      type: "webhook.disabled",
    });
    const webhookRepo = createMockWebhookRepo();
    const eventsRepo = createMockEventsRepo([disabledEvent]);

    await dispatchNewEvents({ webhookRepo, eventsRepo, encryption: null });

    expect(webhookRepo._createdAttempts).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("delivers non-lifecycle events normally alongside lifecycle events", async () => {
    const normalEvent = makeStoredEvent({ id: "evt_normal", type: "project.created" });
    const lifecycleEvent = makeStoredEvent({ id: "evt_lifecycle", type: "webhook.delivery_succeeded" });

    const webhookRepo = createMockWebhookRepo();
    const eventsRepo = createMockEventsRepo([normalEvent, lifecycleEvent]);

    const result = await dispatchNewEvents({ webhookRepo, eventsRepo, encryption: null });

    // Only the normal event should be delivered
    expect(result.dispatched).toBe(1);
    expect(webhookRepo._createdAttempts).toHaveLength(1);
    expect(webhookRepo._createdAttempts[0]!.eventId).toBe("evt_normal");
    // Cursor should advance past both
    expect(webhookRepo._advancedCursors[0]!.lastEventId).toBe("evt_lifecycle");
  });
});

// ── Auto-disable tests ──────────────────────────────────────

describe("auto-disable endpoint after repeated failures", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("disables endpoint when failure count reaches threshold", async () => {
    globalThis.fetch = async () => new Response("Error", { status: 500 });

    // Terminal failure attempt (at MAX_RETRIES)
    const retryable: WebhookDeliveryAttempt = {
      id: "fail-threshold-1",
      orgId: TEST_ORG_UUID,
      endpointId: TEST_ENDPOINT_UUID,
      subscriptionId: TEST_SUBSCRIPTION_UUID,
      eventId: TEST_EVENT_ID,
      eventType: "project.created",
      status: "retrying",
      attemptNumber: 5, // MAX_RETRIES → terminal
      httpStatusCode: 500,
      failureReason: "HTTP 500",
      idempotencyKey: null,
      nextRetryAt: new Date(Date.now() - 1000),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const webhookRepo = createMockWebhookRepo({
      retryable: [retryable],
      consecutiveFailures: AUTO_DISABLE_FAILURE_THRESHOLD, // At threshold
    });
    const eventsRepo = createMockEventsRepo();

    await retryFailedDeliveries({ webhookRepo, eventsRepo, encryption: null });

    // Endpoint should be disabled
    expect(webhookRepo._disabledEndpoints).toHaveLength(1);
    expect(webhookRepo._disabledEndpoints[0]!.reason).toBe("repeated_delivery_failures");

    // webhook.disabled audit event should be emitted
    expect(eventsRepo._appendedEventsWithAudit).toHaveLength(1);
    expect(eventsRepo._appendedEventsWithAudit[0]!.event.type).toBe("webhook.disabled");
    expect(eventsRepo._appendedEventsWithAudit[0]!.event.payload).toHaveProperty("reason", "repeated_delivery_failures");
    expect(eventsRepo._appendedEventsWithAudit[0]!.event.payload).toHaveProperty("failure_threshold", AUTO_DISABLE_FAILURE_THRESHOLD);
  });

  it("does not disable endpoint when below threshold", async () => {
    globalThis.fetch = async () => new Response("Error", { status: 500 });

    const retryable: WebhookDeliveryAttempt = {
      id: "below-threshold-1",
      orgId: TEST_ORG_UUID,
      endpointId: TEST_ENDPOINT_UUID,
      subscriptionId: TEST_SUBSCRIPTION_UUID,
      eventId: TEST_EVENT_ID,
      eventType: "project.created",
      status: "retrying",
      attemptNumber: 5,
      httpStatusCode: 500,
      failureReason: "HTTP 500",
      idempotencyKey: null,
      nextRetryAt: new Date(Date.now() - 1000),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const webhookRepo = createMockWebhookRepo({
      retryable: [retryable],
      consecutiveFailures: AUTO_DISABLE_FAILURE_THRESHOLD - 1, // Below threshold
    });
    const eventsRepo = createMockEventsRepo();

    await retryFailedDeliveries({ webhookRepo, eventsRepo, encryption: null });

    // Should NOT disable
    expect(webhookRepo._disabledEndpoints).toHaveLength(0);
    expect(eventsRepo._appendedEventsWithAudit).toHaveLength(0);
  });

  it("already-disabled endpoint does not receive HTTP delivery", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async () => {
      fetchCallCount++;
      return new Response("OK", { status: 200 });
    };

    const event = makeStoredEvent();
    const webhookRepo = createMockWebhookRepo({
      endpoint: {
        id: TEST_ENDPOINT_UUID,
        orgId: TEST_ORG_UUID,
        url: "https://example.com/webhook",
        status: "disabled",
        secretCiphertext: null,
        secretVersion: 1,
        previousSecretCiphertext: null,
        previousSecretVersion: null,
        previousSecretExpiresAt: null,
      },
    });
    const eventsRepo = createMockEventsRepo([event]);

    await dispatchNewEvents({ webhookRepo, eventsRepo, encryption: null });

    expect(fetchCallCount).toBe(0);
    expect(webhookRepo._updatedAttempts[0]!.input.status).toBe("failed");
    expect(webhookRepo._updatedAttempts[0]!.input.failureReason).toBe("endpoint_disabled");
  });

  it("auto-disable is idempotent for already-disabled endpoints", async () => {
    globalThis.fetch = async () => new Response("Error", { status: 500 });

    const retryable: WebhookDeliveryAttempt = {
      id: "idempotent-disable-1",
      orgId: TEST_ORG_UUID,
      endpointId: TEST_ENDPOINT_UUID,
      subscriptionId: TEST_SUBSCRIPTION_UUID,
      eventId: TEST_EVENT_ID,
      eventType: "project.created",
      status: "retrying",
      attemptNumber: 5,
      httpStatusCode: 500,
      failureReason: "HTTP 500",
      idempotencyKey: null,
      nextRetryAt: new Date(Date.now() - 1000),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const webhookRepo = createMockWebhookRepo({
      retryable: [retryable],
      consecutiveFailures: AUTO_DISABLE_FAILURE_THRESHOLD,
    });
    // Make disableEndpoint return not_found (already disabled)
    webhookRepo.disableEndpoint = async () => ({ ok: false as const, error: { kind: "not_found" as const } });
    const eventsRepo = createMockEventsRepo();

    await retryFailedDeliveries({ webhookRepo, eventsRepo, encryption: null });

    // No webhook.disabled event should be emitted for already-disabled endpoint
    expect(eventsRepo._appendedEventsWithAudit).toHaveLength(0);
  });
});

// ── buildDeliveryLifecyclePayload tests ─────────────────────

describe("buildDeliveryLifecyclePayload", () => {
  it("returns safe metadata without secrets", () => {
    const attempt: WebhookDeliveryAttempt = {
      id: "attempt-1",
      orgId: TEST_ORG_UUID,
      endpointId: TEST_ENDPOINT_UUID,
      subscriptionId: TEST_SUBSCRIPTION_UUID,
      eventId: TEST_EVENT_ID,
      eventType: "project.created",
      status: "success",
      attemptNumber: 1,
      httpStatusCode: 200,
      failureReason: null,
      idempotencyKey: "key-1",
      nextRetryAt: null,
      completedAt: new Date("2026-05-29T12:00:00Z"),
      createdAt: new Date("2026-05-29T11:00:00Z"),
      updatedAt: new Date("2026-05-29T12:00:00Z"),
    };

    const payload = buildDeliveryLifecyclePayload(attempt);

    expect(payload.delivery_attempt_id).toBe("attempt-1");
    expect(payload.endpoint_id).toBe(TEST_ENDPOINT_UUID);
    expect(payload.subscription_id).toBe(TEST_SUBSCRIPTION_UUID);
    expect(payload.source_event_id).toBe(TEST_EVENT_ID);
    expect(payload.source_event_type).toBe("project.created");
    expect(payload.http_status_code).toBe(200);
    expect(payload.failure_reason).toBeNull();
    expect(payload.attempt_number).toBe(1);
    expect(payload.completed_at).toBe("2026-05-29T12:00:00.000Z");

    // No secret-like fields
    const keys = Object.keys(payload);
    expect(keys).not.toContain("secret_ciphertext");
    expect(keys).not.toContain("response_body");
    expect(keys).not.toContain("stack_trace");
  });
});
