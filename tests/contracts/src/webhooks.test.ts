import type {
  PublicWebhookEndpoint,
  PublicWebhookSubscription,
  PublicWebhookDeliveryAttempt,
  ListWebhookEndpointsResponse,
  CreateWebhookEndpointRequest,
  UpdateWebhookEndpointRequest,
  CreateWebhookSubscriptionRequest,
  ListWebhookSubscriptionsResponse,
  ListWebhookDeliveryAttemptsResponse,
  RotateWebhookSecretResponse,
  DisableWebhookEndpointRequest,
  ReplayWebhookDeliveryRequest,
  ReplayWebhookDeliveryResponse,
  DeleteWebhookEndpointResponse,
} from "@saas/contracts/webhooks";

// ── Webhook endpoint contract tests ───────────────────────

describe("contracts: webhook endpoint types", () => {
  it("PublicWebhookEndpoint shape has required fields and no secret material", () => {
    const endpoint: PublicWebhookEndpoint = {
      id: "ep-001",
      orgId: "org-001",
      projectId: null,
      url: "https://example.com/webhook",
      name: "Test",
      description: null,
      status: "active",
      disabledReason: null,
      disabledAt: null,
      secretVersion: 1,
      secretLastRotatedAt: null,
      createdAt: "2026-01-15T10:00:00Z",
      updatedAt: "2026-01-15T10:00:00Z",
    };
    expect(endpoint.id).toBe("ep-001");
    expect(endpoint.orgId).toBe("org-001");
    expect(endpoint.secretVersion).toBe(1);
    // Must not include secret material
    expect("signingSecret" in endpoint).toBe(false);
    expect("secretCiphertext" in endpoint).toBe(false);
    expect("secret_ciphertext" in endpoint).toBe(false);
    expect("secretHash" in endpoint).toBe(false);
    expect("plaintext" in endpoint).toBe(false);
  });

  it("ListWebhookEndpointsResponse has endpoints array and cursor", () => {
    const response: ListWebhookEndpointsResponse = {
      endpoints: [],
      nextCursor: null,
    };
    expect(response.endpoints).toHaveLength(0);
    expect(response.nextCursor).toBeNull();
  });

  it("CreateWebhookEndpointRequest has url and optional fields", () => {
    const req: CreateWebhookEndpointRequest = {
      url: "https://example.com/webhook",
      name: "My Hook",
      projectId: "prj-001",
    };
    expect(req.url).toBe("https://example.com/webhook");
    // Must not accept secret values
    expect("signingSecret" in req).toBe(false);
    expect("secret" in req).toBe(false);
  });

  it("UpdateWebhookEndpointRequest allows partial updates", () => {
    const req: UpdateWebhookEndpointRequest = { url: "https://new.example.com" };
    expect(req.url).toBe("https://new.example.com");
    expect(req.name).toBeUndefined();
  });

  it("DisableWebhookEndpointRequest has optional reason", () => {
    const req: DisableWebhookEndpointRequest = { reason: "Too many failures" };
    expect(req.reason).toBe("Too many failures");
  });

  it("DeleteWebhookEndpointResponse has deleted: true", () => {
    const res: DeleteWebhookEndpointResponse = { deleted: true };
    expect(res.deleted).toBe(true);
  });

  it("RotateWebhookSecretResponse returns endpoint without secret material", () => {
    const res: RotateWebhookSecretResponse = {
      endpoint: {
        id: "ep-001",
        orgId: "org-001",
        projectId: null,
        url: "https://example.com/webhook",
        name: null,
        description: null,
        status: "active",
        disabledReason: null,
        disabledAt: null,
        secretVersion: 2,
        secretLastRotatedAt: "2026-01-15T10:00:00Z",
        createdAt: "2026-01-15T10:00:00Z",
        updatedAt: "2026-01-15T10:00:00Z",
      },
      previousSecretExpiresAt: "2026-01-16T10:00:00Z",
      gracePeriodSeconds: 86400,
    };
    expect(res.endpoint.secretVersion).toBe(2);
    expect("signingSecret" in res.endpoint).toBe(false);
    // Grace window expiry is operator-visible but contains no secret material
    expect(typeof res.previousSecretExpiresAt === "string" || res.previousSecretExpiresAt === null).toBe(true);
    expect(typeof res.gracePeriodSeconds).toBe("number");
  });

  it("RotateWebhookSecretResponse can carry reveal-once plaintext `whsec_<32 hex>`", () => {
    const res: RotateWebhookSecretResponse = {
      endpoint: {
        id: "ep-001",
        orgId: "org-001",
        projectId: null,
        url: "https://example.com/webhook",
        name: null,
        description: null,
        status: "active",
        disabledReason: null,
        disabledAt: null,
        secretVersion: 3,
        secretLastRotatedAt: "2026-01-15T10:00:00Z",
        createdAt: "2026-01-15T10:00:00Z",
        updatedAt: "2026-01-15T10:00:00Z",
      },
      secret: "whsec_0123456789abcdef0123456789abcdef",
      previousSecretExpiresAt: null,
      gracePeriodSeconds: 86400,
    };
    // Reveal-once contract: optional plaintext follows the whsec_ + 32 hex shape
    expect(res.secret).toMatch(/^whsec_[0-9a-f]{32}$/);
  });

  it("PublicWebhookEndpoint supports all status values", () => {
    const statuses: PublicWebhookEndpoint["status"][] = ["active", "disabled", "pending"];
    statuses.forEach((s) => expect(typeof s).toBe("string"));
  });
});

// ── Webhook subscription contract tests ───────────────────

describe("contracts: webhook subscription types", () => {
  it("PublicWebhookSubscription shape has required fields", () => {
    const sub: PublicWebhookSubscription = {
      id: "sub-001",
      orgId: "org-001",
      endpointId: "ep-001",
      projectId: null,
      eventType: "project.created",
      enabled: true,
      createdAt: "2026-01-15T10:00:00Z",
      updatedAt: "2026-01-15T10:00:00Z",
    };
    expect(sub.eventType).toBe("project.created");
    expect(sub.enabled).toBe(true);
  });

  it("ListWebhookSubscriptionsResponse has subscriptions array", () => {
    const response: ListWebhookSubscriptionsResponse = {
      subscriptions: [],
      nextCursor: null,
    };
    expect(response.subscriptions).toHaveLength(0);
  });

  it("CreateWebhookSubscriptionRequest has endpointId and eventType", () => {
    const req: CreateWebhookSubscriptionRequest = {
      endpointId: "ep-001",
      eventType: "member.added",
      projectId: "prj-001",
    };
    expect(req.endpointId).toBe("ep-001");
    expect(req.projectId).toBe("prj-001");
  });
});

// ── Webhook delivery attempt contract tests ───────────────

describe("contracts: webhook delivery attempt types", () => {
  it("PublicWebhookDeliveryAttempt shape has required fields and no raw payload", () => {
    const attempt: PublicWebhookDeliveryAttempt = {
      id: "del-001",
      orgId: "org-001",
      endpointId: "ep-001",
      subscriptionId: "sub-001",
      eventId: "evt-001",
      eventType: "project.created",
      status: "success",
      attemptNumber: 1,
      httpStatusCode: 200,
      failureReason: null,
      idempotencyKey: null,
      nextRetryAt: null,
      completedAt: "2026-01-15T10:00:00Z",
      createdAt: "2026-01-15T10:00:00Z",
      updatedAt: "2026-01-15T10:00:00Z",
    };
    expect(attempt.status).toBe("success");
    expect(attempt.httpStatusCode).toBe(200);
    // Must not include raw event payload or response body
    expect("eventPayload" in attempt).toBe(false);
    expect("event_payload" in attempt).toBe(false);
    expect("responseBody" in attempt).toBe(false);
    expect("response_body" in attempt).toBe(false);
  });

  it("ListWebhookDeliveryAttemptsResponse has deliveryAttempts array", () => {
    const response: ListWebhookDeliveryAttemptsResponse = {
      deliveryAttempts: [],
      nextCursor: null,
    };
    expect(response.deliveryAttempts).toHaveLength(0);
  });

  it("PublicWebhookDeliveryAttempt supports all status values", () => {
    const statuses: PublicWebhookDeliveryAttempt["status"][] = ["pending", "success", "failed", "retrying"];
    statuses.forEach((s) => expect(typeof s).toBe("string"));
  });

  it("ReplayWebhookDeliveryResponse wraps a single public delivery attempt", () => {
    const response: ReplayWebhookDeliveryResponse = {
      deliveryAttempt: {
        id: "del-replay-001",
        orgId: "org-001",
        endpointId: "whe-001",
        subscriptionId: "whs-001",
        eventId: "evt-001",
        eventType: "user.created",
        status: "success",
        attemptNumber: 1,
        httpStatusCode: 200,
        failureReason: null,
        idempotencyKey: "whs-001:evt-001:replay:new-uuid",
        nextRetryAt: null,
        completedAt: "2026-02-01T10:00:00.000Z",
        createdAt: "2026-02-01T09:59:59.000Z",
        updatedAt: "2026-02-01T10:00:00.000Z",
      },
    };
    expect(response.deliveryAttempt.status).toBe("success");
    // No secret material or raw payload field on the response.
    expect(JSON.stringify(response)).not.toContain("payload");
    expect(JSON.stringify(response)).not.toContain("secret");
  });

  it("ReplayWebhookDeliveryRequest is an empty (fieldless) body", () => {
    const request: ReplayWebhookDeliveryRequest = {};
    expect(Object.keys(request)).toHaveLength(0);
  });
});
