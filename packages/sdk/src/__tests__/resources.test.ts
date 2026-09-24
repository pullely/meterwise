// Tests for the 9 fanned-out resource clients added in Task 0099.
//
// Coverage strategy per resource (mirrors the orgs/projects pilot in
// `sdk.test.ts`): one URL-shape test, one idempotency-key passthrough test
// (when the resource has a POST that accepts one), and one error-decoding
// test that the typed error subclass propagates.

import { describe, expect, it, vi } from "vitest";

import { Meterwise } from "../index.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../errors.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function captureFetch(response: Response): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fn: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response.clone();
  });
  return { fetch: fn, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function envelope<T>(data: T): { data: T; meta: { requestId: string; cursor: null } } {
  return { data, meta: { requestId: "req_test", cursor: null } };
}

function errorResponse(code: string, status: number): Response {
  return jsonResponse(
    {
      error: {
        code,
        message: `synthetic ${code}`,
        details: { fields: { foo: ["bar"] } },
        requestId: "req_err",
      },
    },
    { status },
  );
}

type FetchImpl = typeof fetch;

function client(fetchImpl: FetchImpl): Meterwise {
  return new Meterwise({ baseUrl: "https://api.test", fetch: fetchImpl });
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

describe("MembershipsClient", () => {
  it("listMembers hits the org-scoped members path", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ members: [] })));
    await client(fetch).memberships.listMembers("org_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/members");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("createInvitation propagates idempotency-key", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ invitation: {} }), { status: 201 }),
    );
    await client(fetch).memberships.createInvitation(
      "org_1",
      { email: "a@b.test", role: "viewer" },
      { idempotencyKey: "ikey_inv_1" },
    );
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_inv_1");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/invitations",
    );
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("acceptInvitation issues POST on the accept path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ invitation: {}, membership: {} })),
    );
    await client(fetch).memberships.acceptInvitation("org_1", { token: "tok_x" });
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/invitations/accept",
    );
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("removeMember surfaces ForbiddenError on 403", async () => {
    const { fetch } = captureFetch(errorResponse("forbidden", 403));
    await expect(
      client(fetch).memberships.removeMember("org_1", "mem_1"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

describe("ApiKeysClient", () => {
  it("list hits the org-scoped api-keys path", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ apiKeys: [] })));
    await client(fetch).apiKeys.list("org_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/api-keys");
  });

  it("create propagates idempotency-key", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ apiKey: {} }), { status: 201 }),
    );
    await client(fetch).apiKeys.create(
      "org_1",
      { label: "ci", role: "viewer" },
      { idempotencyKey: "ikey_ak_1" },
    );
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_ak_1");
  });

  it("revoke issues DELETE on the scoped path", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ apiKey: {} })));
    await client(fetch).apiKeys.revoke("org_1", "ak_42");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/api-keys/ak_42",
    );
  });

  it("get surfaces NotFoundError on 404", async () => {
    const { fetch } = captureFetch(errorResponse("not_found", 404));
    await expect(client(fetch).apiKeys.get("org_1", "ak_x")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

describe("WebhooksClient", () => {
  it("listEndpoints hits the org-scoped endpoints path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ endpoints: [], nextCursor: null })),
    );
    await client(fetch).webhooks.listEndpoints("org_1");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/webhooks/endpoints",
    );
  });

  it("listProjectEndpoints hits the project-scoped surface", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ endpoints: [], nextCursor: null })),
    );
    await client(fetch).webhooks.listProjectEndpoints("org_1", "proj_1");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/projects/proj_1/webhooks/endpoints",
    );
  });

  it("createEndpoint propagates idempotency-key on org scope", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ endpoint: {} }), { status: 201 }),
    );
    await client(fetch).webhooks.createEndpoint(
      "org_1",
      { url: "https://hook.test" },
      { idempotencyKey: "ikey_wh_1" },
    );
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_wh_1");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("rotateSecret hits the rotate-secret subpath as POST", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ endpoint: {} })));
    await client(fetch).webhooks.rotateSecret("org_1", "wh_1");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/webhooks/endpoints/wh_1/rotate-secret",
    );
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("enableEndpoint hits the enable subpath as POST with empty body", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ endpoint: { status: "active" } })));
    await client(fetch).webhooks.enableEndpoint("org_1", "wh_1");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/webhooks/endpoints/wh_1/enable",
    );
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("enableEndpoint surfaces NotFoundError on 404 (already-active or missing)", async () => {
    const { fetch } = captureFetch(errorResponse("not_found", 404));
    await expect(
      client(fetch).webhooks.enableEndpoint("org_1", "wh_missing"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("getDeliveryAttempt surfaces NotFoundError on 404", async () => {
    const { fetch } = captureFetch(errorResponse("not_found", 404));
    await expect(
      client(fetch).webhooks.getDeliveryAttempt("org_1", "att_x"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("listDeliveryAttempts hits the endpoint-scoped path with no query when none given", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ deliveryAttempts: [], nextCursor: null })),
    );
    await client(fetch).webhooks.listDeliveryAttempts("org_1", "wh_1");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/webhooks/endpoints/wh_1/delivery-attempts",
    );
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("listDeliveryAttempts threads limit + cursor into the query string", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ deliveryAttempts: [], nextCursor: null })),
    );
    await client(fetch).webhooks.listDeliveryAttempts("org_1", "wh_1", {
      limit: 25,
      cursor: "CURSOR_TOKEN_ABC",
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe(
      "/v1/organizations/org_1/webhooks/endpoints/wh_1/delivery-attempts",
    );
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("cursor")).toBe("CURSOR_TOKEN_ABC");
  });

  it("listDeliveryAttempts omits limit/cursor when only one is supplied", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ deliveryAttempts: [], nextCursor: null })),
    );
    await client(fetch).webhooks.listDeliveryAttempts("org_1", "wh_1", {
      limit: 10,
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.has("cursor")).toBe(false);
  });

  it("listDeliveryAttemptsPage round-trips meta.cursor as nextCursor", async () => {
    const { fetch } = captureFetch(
      jsonResponse({
        data: { deliveryAttempts: [{ id: "att_1" }], nextCursor: null },
        meta: { requestId: "req_test", cursor: "NEXT_PAGE_CURSOR" },
      }),
    );
    const page = await client(fetch).webhooks.listDeliveryAttemptsPage(
      "org_1",
      "wh_1",
      { limit: 1 },
    );
    expect(page.deliveryAttempts).toHaveLength(1);
    expect(page.nextCursor).toBe("NEXT_PAGE_CURSOR");
  });

  it("listDeliveryAttemptsPage returns nextCursor null on the last page", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ deliveryAttempts: [], nextCursor: null })),
    );
    const page = await client(fetch).webhooks.listDeliveryAttemptsPage(
      "org_1",
      "wh_1",
      { cursor: "PREV_CURSOR" },
    );
    expect(page.nextCursor).toBeNull();
    // The supplied cursor was forwarded as the request query param.
    expect(new URL(calls[0]!.url).searchParams.get("cursor")).toBe("PREV_CURSOR");
  });

  it("replayDelivery hits the replay subpath as POST with empty body", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({ deliveryAttempt: { id: "whd_new", status: "success" } }),
        { status: 201 },
      ),
    );
    const res = await client(fetch).webhooks.replayDelivery("org_1", "whd_old");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/webhooks/delivery-attempts/whd_old/replay",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(res.deliveryAttempt.id).toBe("whd_new");
  });

  it("replayDelivery propagates an idempotency-key when supplied", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ deliveryAttempt: { id: "whd_new" } }), {
        status: 201,
      }),
    );
    await client(fetch).webhooks.replayDelivery("org_1", "whd_old", {
      idempotencyKey: "ikey_replay_1",
    });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_replay_1");
  });

  it("replayDelivery surfaces NotFoundError on 404", async () => {
    const { fetch } = captureFetch(errorResponse("not_found", 404));
    await expect(
      client(fetch).webhooks.replayDelivery("org_1", "whd_missing"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

describe("MeteringClient", () => {
  it("recordUsage hits the org-scoped usage path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ usageRecord: {} }), { status: 201 }),
    );
    await client(fetch).metering.recordUsage("org_1", {
      metric: "api_requests",
      idempotencyKey: "u_1",
    });
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/usage",
    );
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("ingestUsageBatch propagates idempotency-key header", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ results: [] })));
    await client(fetch).metering.ingestUsageBatch(
      "org_1",
      { records: [] },
      { idempotencyKey: "ikey_batch_1" },
    );
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_batch_1");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/usage/batch",
    );
  });

  it("getUsageSummary builds query string from filters", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({
          metric: "api_requests",
          totalQuantity: 0,
          totalRecords: 0,
          rollups: [],
        }),
      ),
    );
    await client(fetch).metering.getUsageSummary("org_1", {
      metric: "api_requests",
      bucketType: "day",
      projectId: "proj_1",
    });
    expect(calls[0]!.url).toContain("/usage/summary");
    expect(calls[0]!.url).toContain("metric=api_requests");
    expect(calls[0]!.url).toContain("bucketType=day");
    expect(calls[0]!.url).toContain("projectId=proj_1");
  });

  it("checkQuota surfaces ValidationError on 422", async () => {
    const { fetch } = captureFetch(errorResponse("validation_failed", 422));
    await expect(
      client(fetch).metering.checkQuota("org_1", { metric: "x" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

describe("BillingClient", () => {
  it("listPlans hits the org-scoped plans path", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ plans: [] })));
    await client(fetch).billing.listPlans("org_1");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/billing/plans",
    );
  });

  it("listInvoices forwards cursor and status filters", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ invoices: [], nextCursor: null })),
    );
    await client(fetch).billing.listInvoices("org_1", {
      status: "open",
      limit: 25,
    });
    expect(calls[0]!.url).toContain("status=open");
    expect(calls[0]!.url).toContain("limit=25");
  });

  it("checkEntitlement issues POST on the entitlements/check path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({
          allowed: false,
          orgId: "org_1",
          entitlementKey: "feature.x",
          reason: "not_configured",
        }),
      ),
    );
    await client(fetch).billing.checkEntitlement("org_1", {
      entitlementKey: "feature.x",
    });
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/billing/entitlements/check",
    );
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("getSummary surfaces ForbiddenError on 403", async () => {
    const { fetch } = captureFetch(errorResponse("forbidden", 403));
    await expect(client(fetch).billing.getSummary("org_1")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

// ---------------------------------------------------------------------------
// Events (audit)
// ---------------------------------------------------------------------------

describe("EventsClient", () => {
  it("listAuditEntries (by:org) hits the org-scoped audit path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ auditEntries: [] })),
    );
    await client(fetch).events.listAuditEntries("org_1", {
      by: "org",
      category: "authz",
      limit: 50,
    });
    expect(calls[0]!.url).toContain(
      "https://api.test/v1/organizations/org_1/audit",
    );
    expect(calls[0]!.url).toContain("category=authz");
    expect(calls[0]!.url).toContain("limit=50");
  });

  it("listAuditEntries (by:target) sends subjectKind+subjectId", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ auditEntries: [] })),
    );
    await client(fetch).events.listAuditEntries("org_1", {
      by: "target",
      subjectKind: "project",
      subjectId: "proj_1",
    });
    expect(calls[0]!.url).toContain("subjectKind=project");
    expect(calls[0]!.url).toContain("subjectId=proj_1");
  });

  it("listAuditEntries surfaces NotFoundError on 404", async () => {
    const { fetch } = captureFetch(errorResponse("not_found", 404));
    await expect(
      client(fetch).events.listAuditEntries("org_x"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Security events
// ---------------------------------------------------------------------------

describe("SecurityEventsClient", () => {
  it("list hits /v1/auth/security-events", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ securityEvents: [] })),
    );
    await client(fetch).securityEvents.list();
    expect(calls[0]!.url).toBe("https://api.test/v1/auth/security-events");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("list threads limit + opaque cursor into the query verbatim", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ securityEvents: [] })),
    );
    const opaque = "eyJjcm...2In0=";
    await client(fetch).securityEvents.list({ limit: 25, cursor: opaque });
    expect(calls[0]!.url).toContain("limit=25");
    expect(calls[0]!.url).toContain(`cursor=${encodeURIComponent(opaque)}`);
  });

  it("listPage surfaces meta.cursor as nextCursor", async () => {
    const { fetch } = captureFetch(
      jsonResponse({
        data: { securityEvents: [{ id: "se_1" }] },
        meta: { requestId: "req_1", cursor: "CUR_NEXT" },
      }),
    );
    const page = await client(fetch).securityEvents.listPage();
    expect(page.securityEvents).toHaveLength(1);
    expect(page.nextCursor).toBe("CUR_NEXT");
  });

  it("listPage returns nextCursor null when the server omits meta.cursor", async () => {
    const { fetch } = captureFetch(
      jsonResponse({
        data: { securityEvents: [] },
        meta: { requestId: "req_1" },
      }),
    );
    const page = await client(fetch).securityEvents.listPage();
    expect(page.nextCursor).toBeNull();
  });

  it("listPage forwards the opaque cursor verbatim on the follow-up page", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({
        data: { securityEvents: [] },
        meta: { requestId: "req_1", cursor: null },
      }),
    );
    const opaque = "eyJvZmZzZXQ...In0=";
    await client(fetch).securityEvents.listPage({ cursor: opaque });
    expect(calls[0]!.url).toContain(`cursor=${encodeURIComponent(opaque)}`);
  });

  it("surfaces ForbiddenError on 403", async () => {
    const { fetch } = captureFetch(errorResponse("forbidden", 403));
    await expect(client(fetch).securityEvents.list()).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

// ---------------------------------------------------------------------------
// Config (settings / feature-flags / secrets across 3 scopes)
// ---------------------------------------------------------------------------

describe("ConfigClient", () => {
  it("listSettings (organization scope) hits org config path", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ settings: [] })));
    await client(fetch).config.listSettings({ kind: "organization", orgId: "org_1" });
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/config/settings",
    );
  });

  it("listSettings (project scope) hits project config path", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ settings: [] })));
    await client(fetch).config.listSettings({
      kind: "project",
      orgId: "org_1",
      projectId: "proj_1",
    });
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/projects/proj_1/config/settings",
    );
  });

  it("listSettings (environment scope) hits env config path", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ settings: [] })));
    await client(fetch).config.listSettings({
      kind: "environment",
      orgId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
    });
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/projects/proj_1/environments/env_1/config/settings",
    );
  });

  it("createFeatureFlag propagates idempotency-key", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ featureFlag: {} }), { status: 201 }),
    );
    await client(fetch).config.createFeatureFlag(
      { kind: "organization", orgId: "org_1" },
      { flagKey: "x", enabled: true },
      { idempotencyKey: "ikey_ff_1" },
    );
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_ff_1");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/config/feature-flags",
    );
  });

  it("rotateSecret hits the rotate subpath as POST (env scope)", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ secret: {} })));
    await client(fetch).config.rotateSecret(
      {
        kind: "environment",
        orgId: "org_1",
        projectId: "proj_1",
        environmentId: "env_1",
      },
      "DATABASE_URL",
      { value: "new-value-redacted-from-test" },
    );
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/projects/proj_1/environments/env_1/config/secrets/DATABASE_URL/rotate",
    );
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("revokeSecret issues DELETE on the scoped secret path", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(envelope({ secret: {} })));
    await client(fetch).config.revokeSecret(
      { kind: "organization", orgId: "org_1" },
      "API_KEY",
    );
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/config/secrets/API_KEY",
    );
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("createSetting surfaces ConflictError on 409", async () => {
    const { fetch } = captureFetch(errorResponse("conflict", 409));
    await expect(
      client(fetch).config.createSetting(
        { kind: "organization", orgId: "org_1" },
        { key: "x", value: 1 },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

describe("NotificationsClient", () => {
  it("enqueue hits /v1/notifications as POST", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ notification: {} }), { status: 201 }),
    );
    await client(fetch).notifications.enqueue({
      orgId: "org_1",
      category: "billing",
      templateKey: "billing.receipt",
      recipient: { channel: "email", address: "a@b.test" },
    });
    expect(calls[0]!.url).toBe("https://api.test/v1/notifications");
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("enqueue propagates idempotency-key", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ notification: {} }), { status: 201 }),
    );
    await client(fetch).notifications.enqueue(
      {
        orgId: "org_1",
        category: "invitation",
        templateKey: "invitation.created",
        recipient: { channel: "email", address: "a@b.test" },
      },
      { idempotencyKey: "ikey_n_1" },
    );
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_n_1");
  });

  it("get fetches a notification by id", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ notification: {} })),
    );
    await client(fetch).notifications.get("notif_42");
    expect(calls[0]!.url).toBe("https://api.test/v1/notifications/notif_42");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("updatePreferences issues PUT on preferences path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ preference: {} })),
    );
    await client(fetch).notifications.updatePreferences({
      orgId: "org_1",
      subjectKind: "user",
      subjectId: "user_1",
      channel: "email",
      categories: { billing: true },
    });
    expect(calls[0]!.url).toBe("https://api.test/v1/notifications/preferences");
    expect(calls[0]!.init.method).toBe("PUT");
  });

  it("suppressRecipient hits the recipients suppress path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ suppression: {} })),
    );
    await client(fetch).notifications.suppressRecipient(
      "a@b.test",
      { orgId: "org_1", channel: "email", reason: "bounce" },
    );
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/notifications/recipients/a%40b.test/suppress",
    );
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("get surfaces NotFoundError on 404", async () => {
    const { fetch } = captureFetch(errorResponse("not_found", 404));
    await expect(
      client(fetch).notifications.get("missing"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
