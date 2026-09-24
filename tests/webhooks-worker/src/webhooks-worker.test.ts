import { route } from "@webhooks-worker/router";
import type { Env } from "@webhooks-worker/env";
import { encodeCursor, decodeCursor, parsePageParams } from "@webhooks-worker/pagination";
import {
  generateRequestId,
  parseOrgPublicId,
  parseProjectPublicId,
  parseWebhookEndpointPublicId,
  parseWebhookSubscriptionPublicId,
  parseWebhookDeliveryAttemptPublicId,
  orgPublicId,
  webhookEndpointPublicId,
  webhookSubscriptionPublicId,
  webhookDeliveryAttemptPublicId,
} from "@webhooks-worker/ids";
import {
  toPublicWebhookEndpoint,
  toPublicWebhookSubscription,
  toPublicDeliveryAttempt,
} from "@webhooks-worker/mappers";
import { asUuid } from "@saas/db/ids";
import type { WebhookEndpoint, WebhookSubscription, WebhookDeliveryAttempt } from "@saas/db/webhooks";
import type { AppendEventWithAuditInput, EventsResult, StoredEvent, StoredAuditEntry } from "@saas/db/events";

// ── Test constants ──────────────────────────────────────────
const TEST_ORG_UUID = "11111111-1111-1111-1111-111111111111";
const TEST_ORG_PUBLIC = "org_11111111111111111111111111111111";
const TEST_PROJECT_UUID = "22222222-2222-2222-2222-222222222222";
const TEST_PROJECT_PUBLIC = "prj_22222222222222222222222222222222";
const TEST_ENDPOINT_UUID = "44444444-4444-4444-4444-444444444444";
const TEST_ENDPOINT_PUBLIC = "whe_44444444444444444444444444444444";
const TEST_SUBSCRIPTION_UUID = "55555555-5555-5555-5555-555555555555";
const TEST_SUBSCRIPTION_PUBLIC = "whs_55555555555555555555555555555555";
const TEST_DELIVERY_UUID = "66666666-6666-6666-6666-666666666666";
const TEST_DELIVERY_PUBLIC = "whd_66666666666666666666666666666666";
const TEST_USER_ID = "usr_aabbccdd";

// ── Mock helpers ────────────────────────────────────────────

function createMockFetcher(responseBody: unknown, status = 200): Fetcher & { fetchCalls: Array<{ url: string; init: RequestInit }> } {
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  return {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url, init: init ?? {} });
      return Promise.resolve(new Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      }));
    },
    connect() { throw new Error("not implemented"); },
    fetchCalls,
  } as unknown as Fetcher & { fetchCalls: Array<{ url: string; init: RequestInit }> };
}

function createFakeEnv(overrides?: Record<string, unknown>): Env {
  const base: Record<string, unknown> = {
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: createMockFetcher({ data: { memberships: [{ kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: TEST_ORG_UUID } }] } }),
    POLICY_WORKER: createMockFetcher({ data: { allow: true, reason: "org_admin", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    ENVIRONMENT: "test",
  };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete base[key];
      } else {
        base[key] = value;
      }
    }
  }
  return base as unknown as Env;
}

function makeRequest(method: string, path: string, headers?: Record<string, string>): Request {
  return new Request(`https://webhooks-worker${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-request-id": "req_test123",
      "x-actor-subject-id": TEST_USER_ID,
      "x-actor-subject-type": "user",
      ...headers,
    },
  });
}

function makeUnauthenticatedRequest(method: string, path: string): Request {
  return new Request(`https://webhooks-worker${path}`, {
    method,
    headers: { "content-type": "application/json" },
  });
}

// ── ids.ts tests ────────────────────────────────────────────

describe("ids", () => {
  it("generateRequestId returns req_ prefixed string", () => {
    const id = generateRequestId();
    expect(id).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it("parseOrgPublicId round-trips correctly", () => {
    const publicId = orgPublicId(TEST_ORG_UUID);
    expect(publicId).toBe(TEST_ORG_PUBLIC);
    expect(parseOrgPublicId(publicId)).toBe(TEST_ORG_UUID);
  });

  it("parseOrgPublicId returns null for bad prefix", () => {
    expect(parseOrgPublicId("bad_11111111111111111111111111111111")).toBeNull();
  });

  it("parseOrgPublicId returns null for invalid hex length", () => {
    expect(parseOrgPublicId("org_abc")).toBeNull();
  });

  it("parseProjectPublicId round-trips correctly", () => {
    expect(parseProjectPublicId(TEST_PROJECT_PUBLIC)).toBe(TEST_PROJECT_UUID);
  });

  it("webhookEndpointPublicId round-trips correctly", () => {
    const publicId = webhookEndpointPublicId(TEST_ENDPOINT_UUID);
    expect(publicId).toBe(TEST_ENDPOINT_PUBLIC);
    expect(parseWebhookEndpointPublicId(publicId)).toBe(TEST_ENDPOINT_UUID);
  });

  it("parseWebhookEndpointPublicId returns null for bad prefix", () => {
    expect(parseWebhookEndpointPublicId("bad_44444444444444444444444444444444")).toBeNull();
  });

  it("webhookSubscriptionPublicId round-trips correctly", () => {
    const publicId = webhookSubscriptionPublicId(TEST_SUBSCRIPTION_UUID);
    expect(publicId).toBe(TEST_SUBSCRIPTION_PUBLIC);
    expect(parseWebhookSubscriptionPublicId(publicId)).toBe(TEST_SUBSCRIPTION_UUID);
  });

  it("webhookDeliveryAttemptPublicId round-trips correctly", () => {
    const publicId = webhookDeliveryAttemptPublicId(TEST_DELIVERY_UUID);
    expect(publicId).toBe(TEST_DELIVERY_PUBLIC);
    expect(parseWebhookDeliveryAttemptPublicId(publicId)).toBe(TEST_DELIVERY_UUID);
  });

  it("parseWebhookDeliveryAttemptPublicId returns null for bad prefix", () => {
    expect(parseWebhookDeliveryAttemptPublicId("bad_66666666666666666666666666666666")).toBeNull();
  });
});

// ── pagination.ts tests ─────────────────────────────────────

describe("pagination", () => {
  it("encodeCursor / decodeCursor round-trip", () => {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const id = TEST_ORG_UUID;
    const encoded = encodeCursor(createdAt, id);
    const decoded = decodeCursor(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.createdAt).toBe(createdAt);
    expect(decoded!.id).toBe(id);
  });

  it("decodeCursor returns null for garbage", () => {
    expect(decodeCursor("not-base64!!!")).toBeNull();
  });

  it("decodeCursor returns null for wrong version", () => {
    const payload = JSON.stringify({ v: 999, t: "2026-01-01T00:00:00.000Z", i: TEST_ORG_UUID });
    expect(decodeCursor(btoa(payload))).toBeNull();
  });

  it("parsePageParams defaults to limit=50, cursor=null", () => {
    const result = parsePageParams(new URL("https://x/list"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.limit).toBe(50);
      expect(result.value.cursor).toBeNull();
    }
  });

  it("parsePageParams rejects limit > 100", () => {
    const result = parsePageParams(new URL("https://x/list?limit=200"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("limit");
    }
  });

  it("parsePageParams rejects limit=0", () => {
    const result = parsePageParams(new URL("https://x/list?limit=0"));
    expect(result.ok).toBe(false);
  });

  it("parsePageParams accepts valid cursor", () => {
    const cursor = encodeCursor("2026-01-01T00:00:00.000Z", TEST_ORG_UUID);
    const result = parsePageParams(new URL(`https://x/list?cursor=${cursor}`));
    expect(result.ok).toBe(true);
  });

  it("parsePageParams rejects invalid cursor", () => {
    const result = parsePageParams(new URL("https://x/list?cursor=garbage"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("cursor");
    }
  });
});

// ── mappers.ts tests ────────────────────────────────────────

describe("mappers", () => {
  const now = new Date("2026-01-15T12:00:00.000Z");

  it("toPublicWebhookEndpoint maps all fields", () => {
    const endpoint: WebhookEndpoint = {
      id: TEST_ENDPOINT_UUID,
      orgId: TEST_ORG_UUID,
      projectId: TEST_PROJECT_UUID,
      url: "https://example.com/hook",
      name: "My Hook",
      description: "desc",
      status: "active",
      disabledReason: null,
      disabledAt: null,
      secretVersion: 1,
      secretLastRotatedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const pub = toPublicWebhookEndpoint(endpoint);
    expect(pub.id).toBe(TEST_ENDPOINT_PUBLIC);
    expect(pub.orgId).toBe(TEST_ORG_PUBLIC);
    expect(pub.projectId).toBe(TEST_PROJECT_PUBLIC);
    expect(pub.url).toBe("https://example.com/hook");
    expect(pub.name).toBe("My Hook");
    expect(pub.status).toBe("active");
    expect(pub.secretVersion).toBe(1);
    expect(pub.secretLastRotatedAt).toBe("2026-01-15T12:00:00.000Z");
    expect(pub.createdAt).toBe("2026-01-15T12:00:00.000Z");
  });

  it("toPublicWebhookEndpoint handles null projectId", () => {
    const endpoint: WebhookEndpoint = {
      id: TEST_ENDPOINT_UUID,
      orgId: TEST_ORG_UUID,
      projectId: null,
      url: "https://example.com/hook",
      name: null,
      description: null,
      status: "active",
      disabledReason: null,
      disabledAt: null,
      secretVersion: 1,
      secretLastRotatedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const pub = toPublicWebhookEndpoint(endpoint);
    expect(pub.projectId).toBeNull();
    expect(pub.name).toBeNull();
    expect(pub.secretLastRotatedAt).toBeNull();
  });

  it("toPublicWebhookSubscription maps all fields", () => {
    const sub: WebhookSubscription = {
      id: TEST_SUBSCRIPTION_UUID,
      orgId: TEST_ORG_UUID,
      endpointId: TEST_ENDPOINT_UUID,
      projectId: null,
      eventType: "project.created",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    const pub = toPublicWebhookSubscription(sub);
    expect(pub.id).toBe(TEST_SUBSCRIPTION_PUBLIC);
    expect(pub.orgId).toBe(TEST_ORG_PUBLIC);
    expect(pub.endpointId).toBe(TEST_ENDPOINT_PUBLIC);
    expect(pub.eventType).toBe("project.created");
    expect(pub.enabled).toBe(true);
  });

  it("toPublicDeliveryAttempt maps all fields", () => {
    const attempt: WebhookDeliveryAttempt = {
      id: TEST_DELIVERY_UUID,
      orgId: TEST_ORG_UUID,
      endpointId: TEST_ENDPOINT_UUID,
      subscriptionId: TEST_SUBSCRIPTION_UUID,
      eventId: "evt_abc123",
      eventType: "project.created",
      status: "success",
      attemptNumber: 1,
      httpStatusCode: 200,
      failureReason: null,
      idempotencyKey: "idk_abc",
      nextRetryAt: null,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const pub = toPublicDeliveryAttempt(attempt);
    expect(pub.id).toBe(TEST_DELIVERY_PUBLIC);
    expect(pub.endpointId).toBe(TEST_ENDPOINT_PUBLIC);
    expect(pub.subscriptionId).toBe(TEST_SUBSCRIPTION_PUBLIC);
    expect(pub.status).toBe("success");
    expect(pub.attemptNumber).toBe(1);
    expect(pub.httpStatusCode).toBe(200);
    expect(pub.completedAt).toBe("2026-01-15T12:00:00.000Z");
  });
});

// ── router.ts tests ─────────────────────────────────────────

describe("router", () => {
  it("returns 200 for /health", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", "/health");
    const res = await route(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty("service", "webhooks-worker");
  });

  it("returns 503 when PLATFORM_DB is missing", async () => {
    const env = createFakeEnv({ PLATFORM_DB: undefined });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints`);
    const res = await route(req, env);
    expect(res.status).toBe(503);
  });

  it("returns 503 when MEMBERSHIP_WORKER is missing", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: undefined });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints`);
    const res = await route(req, env);
    expect(res.status).toBe(503);
  });

  it("returns 503 when POLICY_WORKER is missing", async () => {
    const env = createFakeEnv({ POLICY_WORKER: undefined });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints`);
    const res = await route(req, env);
    expect(res.status).toBe(503);
  });

  it("returns 401 when actor headers are missing", async () => {
    const env = createFakeEnv();
    const req = makeUnauthenticatedRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints`);
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 404 for unknown path", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", "/v1/organizations/org_abc/unknown");
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 404 when org ID has bad prefix", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", "/v1/organizations/bad_abc/webhooks/endpoints");
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("list endpoints: policy deny returns 404 and leaks no data (PERF12 deny-by-default)", async () => {
    // The PERF12 read runs concurrently with authz; a deny must still 404 and
    // never surface the speculatively read rows.
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({
        data: { allow: false, reason: "denied", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } },
      }),
    });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("endpoints");
    // PERF14b: the deny path still carries the Server-Timing phases, with the
    // parallel authz/db pair (PERF12c) visible in the breakdown.
    const timing = res.headers.get("Server-Timing");
    expect(timing).toBeTruthy();
    for (const phase of ["authz", "db", "total"]) {
      expect(timing).toContain(phase);
    }
  });

  it("returns 405 for PUT on endpoints collection", async () => {
    const env = createFakeEnv();
    const req = makeRequest("PUT", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 405 for PUT on endpoint item", async () => {
    const env = createFakeEnv();
    const req = makeRequest("PUT", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints/${TEST_ENDPOINT_PUBLIC}`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 405 for GET on disable endpoint", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints/${TEST_ENDPOINT_PUBLIC}/disable`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 405 for GET on rotate-secret", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints/${TEST_ENDPOINT_PUBLIC}/rotate-secret`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  // ── Reveal-once secret + audit/event payload sanitisation (B5) ────────
  // Static-source guard: the rotate handler must (a) construct a
  // `whsec_<32 hex>` plaintext for the response, and (b) NEVER include the
  // plaintext variable in the event/audit payload literal. We verify this
  // via source inspection because the handler creates its own repo wiring
  // (no injection), making behavioural mocking heavier than the regression
  // value warrants. Verifier Phase 2 mirrors this grep.

  it("handleRotateWebhookSecret returns reveal-once `whsec_<32 hex>` plaintext", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const handlerPath = path.resolve(
      process.cwd(),
      "../../apps/webhooks-worker/src/handlers/webhook-endpoints.ts",
    );
    const src = await fs.readFile(handlerPath, "utf8");
    // Reveal-shape: response builder forms `whsec_${plaintext}` exactly.
    expect(src).toMatch(/secret:\s*`whsec_\$\{plaintextSecret\}`/);
    // Hex generator: 32 hex chars (consistent with `/^whsec_[0-9a-f]{32}$/`).
    expect(src).toMatch(/randomHex\(32\)/);
  });

  it("handleRotateWebhookSecret never leaks plaintext into event/audit payload", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const handlerPath = path.resolve(
      process.cwd(),
      "../../apps/webhooks-worker/src/handlers/webhook-endpoints.ts",
    );
    const src = await fs.readFile(handlerPath, "utf8");
    // Locate the rotate handler and slice up to the closing audit block.
    const rotateStart = src.indexOf("export async function handleRotateWebhookSecret");
    expect(rotateStart).toBeGreaterThan(-1);
    const rotateBlock = src.slice(rotateStart);
    // The plaintext variable must NOT appear inside any payload: { ... } literal
    // in the rotate handler. We grep for `plaintextSecret` references and
    // confirm none sit inside an event/audit payload object.
    const payloadMatches = [...rotateBlock.matchAll(/payload:\s*\{[^}]*\}/gs)];
    expect(payloadMatches.length).toBeGreaterThan(0);
    for (const m of payloadMatches) {
      expect(m[0]).not.toContain("plaintextSecret");
      expect(m[0]).not.toContain("whsec_");
    }
    // The audit description must be semantic only — no plaintext interpolation.
    const auditDescriptionMatches = [...rotateBlock.matchAll(/description:\s*`[^`]+`|description:\s*"[^"]+"/g)];
    for (const m of auditDescriptionMatches) {
      expect(m[0]).not.toContain("plaintextSecret");
      expect(m[0]).not.toContain("whsec_");
    }
  });

  it("returns 405 for POST on subscription item", async () => {
    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/subscriptions/${TEST_SUBSCRIPTION_PUBLIC}`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 405 for POST on delivery-attempts list", async () => {
    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints/${TEST_ENDPOINT_PUBLIC}/delivery-attempts`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 405 for POST on delivery-attempt item", async () => {
    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/delivery-attempts/${TEST_DELIVERY_PUBLIC}`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("preserves x-request-id from incoming header", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", "/health", { "x-request-id": "req_custom12345" });
    const res = await route(req, env);
    const body = await res.json() as { meta: { requestId: string } };
    expect(body.meta.requestId).toBe("req_custom12345");
  });

  it("generates x-request-id when missing", async () => {
    const env = createFakeEnv();
    const req = new Request("https://webhooks-worker/health", { method: "GET" });
    const res = await route(req, env);
    const body = await res.json() as { meta: { requestId: string } };
    expect(body.meta.requestId).toBeDefined();
    expect(typeof body.meta.requestId).toBe("string");
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  // ── Re-enable endpoint route plumbing ──────────────────────
  it("returns 405 for GET on enable endpoint", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints/${TEST_ENDPOINT_PUBLIC}/enable`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  // ── Manual delivery replay route plumbing (Task 0126) ──────
  it("returns 405 for GET on delivery-attempt replay", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/delivery-attempts/${TEST_DELIVERY_PUBLIC}/replay`);
    const res = await route(req, env);
    // GET is not a registered method on the replay route → 405, proving the
    // path is wired (a fully-unmatched path would 404 instead).
    expect(res.status).toBe(405);
  });
});

// ── handleEnableWebhookEndpoint atomicity (Task 0024 pattern) ──
// The non-tx fallback path is the test seam: it exercises the same
// repo / events-repo wiring the transaction callback uses, and lets us
// assert the three required atomicity invariants without a live PG.

describe("handleEnableWebhookEndpoint — atomicity", () => {
  const orgId = TEST_ORG_UUID;
  const endpointId = TEST_ENDPOINT_UUID;
  const actor = { subjectId: TEST_USER_ID, subjectType: "user" };
  const requestId = "req_atomicity";
  const fixedNow = new Date("2026-01-15T12:00:00.000Z");

  const disabledEndpoint: WebhookEndpoint = {
    id: endpointId,
    orgId,
    projectId: null,
    url: "https://example.com/hook",
    name: "Hook",
    description: null,
    status: "disabled",
    disabledReason: "ops paused",
    disabledAt: fixedNow,
    secretVersion: 1,
    secretLastRotatedAt: null,
    createdAt: fixedNow,
    updatedAt: fixedNow,
  };

  const activeEndpoint: WebhookEndpoint = { ...disabledEndpoint, status: "active", disabledReason: null, disabledAt: null };

  function makeFakeRepo(opts: {
    enableResult?: { ok: true; value: WebhookEndpoint } | { ok: false; error: { kind: "not_found" } | { kind: "internal"; message: string } };
    enableSpy?: { called: boolean };
  } = {}) {
    return {
      async getEndpoint() {
        return { ok: true as const, value: disabledEndpoint };
      },
      async enableEndpoint() {
        if (opts.enableSpy) opts.enableSpy.called = true;
        return opts.enableResult ?? ({ ok: true as const, value: activeEndpoint });
      },
    };
  }

  it("mutation success → emits webhook_endpoint.enabled event + audit row", async () => {
    const { handleEnableWebhookEndpoint } = await import("@webhooks-worker/handlers/webhook-endpoints");
    const repo = makeFakeRepo();
    const appended: Array<{ type: string; description: string | null }> = [];
    const eventsRepo: { appendEventWithAudit: (input: AppendEventWithAuditInput) => Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>> } = {
      async appendEventWithAudit(input) {
        appended.push({ type: input.event.type, description: input.audit.description ?? null });
        return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
      },
    };

    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints/${TEST_ENDPOINT_PUBLIC}/enable`);
    const res = await handleEnableWebhookEndpoint(req, env, requestId, actor, orgId, endpointId, {
      repo, eventsRepo, now: () => fixedNow, generateId: () => "gen_id",
    });

    expect(res.status).toBe(200);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.type).toBe("webhook_endpoint.enabled");
    expect(appended[0]!.description).toMatch(/re-enabled/i);
  });

  it("mutation failure → no event/audit append", async () => {
    const { handleEnableWebhookEndpoint } = await import("@webhooks-worker/handlers/webhook-endpoints");
    const repo = makeFakeRepo({
      enableResult: { ok: false, error: { kind: "not_found" } },
    });
    let appended = false;
    const eventsRepo: { appendEventWithAudit: (input: AppendEventWithAuditInput) => Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>> } = {
      async appendEventWithAudit() {
        appended = true;
        return { ok: true as const, value: { event: {} as StoredEvent, audit: {} as StoredAuditEntry } };
      },
    };

    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints/${TEST_ENDPOINT_PUBLIC}/enable`);
    const res = await handleEnableWebhookEndpoint(req, env, requestId, actor, orgId, endpointId, {
      repo, eventsRepo, now: () => fixedNow, generateId: () => "gen_id",
    });

    expect(res.status).toBe(404);
    expect(appended).toBe(false);
  });

  it("event-append failure surfaces a safe error envelope (rollback signal)", async () => {
    // In the live tx path, an event-append failure throws and the
    // transaction rolls back. The non-tx seam mirrors the post-condition:
    // a safe 503 envelope to the caller. This locks in the contract.
    const { handleEnableWebhookEndpoint } = await import("@webhooks-worker/handlers/webhook-endpoints");
    const repo = makeFakeRepo();
    const eventsRepo: { appendEventWithAudit: (input: AppendEventWithAuditInput) => Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>> } = {
      async appendEventWithAudit() {
        return { ok: false as const, error: { kind: "internal" as const, message: "db down" } };
      },
    };

    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/webhooks/endpoints/${TEST_ENDPOINT_PUBLIC}/enable`);
    const res = await handleEnableWebhookEndpoint(req, env, requestId, actor, orgId, endpointId, {
      repo, eventsRepo, now: () => fixedNow, generateId: () => "gen_id",
    });

    expect(res.status).toBe(503);
  });

  it("transactional path source-asserts: same txExec wires both repos and event failure throws", async () => {
    // Static-source guard mirroring the rotate-secret reveal-once pattern.
    // The transactional branch must (a) construct both repos from the
    // SAME txExec, and (b) throw on event-append failure to roll back.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const handlerPath = path.resolve(
      process.cwd(),
      "../../apps/webhooks-worker/src/handlers/webhook-endpoints.ts",
    );
    const src = await fs.readFile(handlerPath, "utf8");
    const enableStart = src.indexOf("export async function handleEnableWebhookEndpoint");
    expect(enableStart).toBeGreaterThan(-1);
    const enableBlock = src.slice(enableStart);
    expect(enableBlock).toMatch(/createWebhookRepository\(txExec\)/);
    expect(enableBlock).toMatch(/createEventsRepository\(txExec\)/);
    expect(enableBlock).toMatch(/throw new Error\("event_append_failed"\)/);
    // Re-enable SQL clears disabled_reason / disabled_at and guards on status.
    const repoSrc = await fs.readFile(
      path.resolve(process.cwd(), "../../packages/db/src/webhooks/repository.ts"),
      "utf8",
    );
    expect(repoSrc).toMatch(/SET status = 'active', disabled_reason = NULL, disabled_at = NULL/);
    expect(repoSrc).toMatch(/AND status = 'disabled'/);
  });
});

describe("project-scoped webhook create: project id decode", () => {
  const orgUuid = asUuid("11111111-1111-1111-1111-111111111111");
  const actor = { subjectId: "usr_" + "ab".repeat(16), subjectType: "user" };

  function postEndpoint(body: unknown): Request {
    return new Request("https://webhooks-worker/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects a malformed projectId with 422 before touching the DB", async () => {
    const { handleCreateWebhookEndpoint } = await import("@webhooks-worker/handlers/webhook-endpoints");
    // {} as Env is never dereferenced: the projectId guard returns before any
    // env/DB/auth access. `prj_short` is not a valid `prj_<32 hex>`.
    const res = await handleCreateWebhookEndpoint(
      postEndpoint({ url: "https://example.com/hook", projectId: "prj_short" }),
      {} as never,
      "req_proj",
      actor as never,
      orgUuid,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { details?: { fields?: Record<string, unknown> } } };
    expect(body.error.details?.fields?.projectId).toBeDefined();
  });

  it("rejects a bare-UUID projectId (must be the public prj_ form)", async () => {
    const { handleCreateWebhookEndpoint } = await import("@webhooks-worker/handlers/webhook-endpoints");
    const res = await handleCreateWebhookEndpoint(
      postEndpoint({ url: "https://example.com/hook", projectId: "22222222-2222-2222-2222-222222222222" }),
      {} as never,
      "req_proj2",
      actor as never,
      orgUuid,
    );
    expect(res.status).toBe(422);
  });
});
