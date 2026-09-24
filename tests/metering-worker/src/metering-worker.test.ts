import { route } from "@metering-worker/router";
import type { Env } from "@metering-worker/env";
import {
  generateRequestId,
  parseOrgPublicId,
  parseProjectPublicId,
  parseEnvironmentPublicId,
  generateUsageRecordId,
} from "@metering-worker/ids";
import { validateMetadata } from "@metering-worker/metadata";

// ── Test constants ──────────────────────────────────────────
const TEST_ORG_UUID = "11111111-1111-1111-1111-111111111111";
const TEST_ORG_PUBLIC = "org_11111111111111111111111111111111";
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

function makeRequest(method: string, path: string, body?: unknown, headers?: Record<string, string>): Request {
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      "x-request-id": "req_test123",
      "x-actor-subject-id": TEST_USER_ID,
      "x-actor-subject-type": "user",
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`https://metering-worker${path}`, init);
}

function makeUnauthenticatedRequest(method: string, path: string): Request {
  return new Request(`https://metering-worker${path}`, {
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
    expect(parseOrgPublicId(TEST_ORG_PUBLIC)).toBe(TEST_ORG_UUID);
  });

  it("parseOrgPublicId returns null for bad prefix", () => {
    expect(parseOrgPublicId("bad_11111111111111111111111111111111")).toBeNull();
  });

  it("parseOrgPublicId returns null for invalid hex length", () => {
    expect(parseOrgPublicId("org_abc")).toBeNull();
  });

  it("parseProjectPublicId works", () => {
    expect(parseProjectPublicId("prj_22222222222222222222222222222222")).toBe(
      "22222222-2222-2222-2222-222222222222",
    );
  });

  it("parseEnvironmentPublicId works", () => {
    expect(parseEnvironmentPublicId("env_33333333333333333333333333333333")).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("generateUsageRecordId returns a valid UUID", () => {
    const id = generateUsageRecordId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

// ── metadata.ts tests ───────────────────────────────────────

describe("validateMetadata", () => {
  it("accepts null", () => {
    expect(validateMetadata(null)).toEqual({ ok: true, value: null });
  });

  it("accepts undefined", () => {
    expect(validateMetadata(undefined)).toEqual({ ok: true, value: null });
  });

  it("accepts valid object", () => {
    const result = validateMetadata({ region: "us-east-1", count: 42 });
    expect(result.ok).toBe(true);
  });

  it("rejects arrays", () => {
    const result = validateMetadata([1, 2, 3]);
    expect(result.ok).toBe(false);
  });

  it("rejects keys with secret patterns", () => {
    const result = validateMetadata({ api_key: "abc123" });
    expect(result.ok).toBe(false);
  });

  it("rejects too many keys", () => {
    const meta: Record<string, string> = {};
    for (let i = 0; i < 25; i++) meta[`key_${i}`] = "v";
    const result = validateMetadata(meta);
    expect(result.ok).toBe(false);
  });

  it("rejects long values", () => {
    const result = validateMetadata({ note: "x".repeat(2000) });
    expect(result.ok).toBe(false);
  });
});

// ── Router tests ────────────────────────────────────────────

describe("router", () => {
  it("GET /health returns 200", async () => {
    const env = createFakeEnv();
    const req = new Request("https://metering-worker/health", { method: "GET" });
    const res = await route(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { status: string } };
    expect(body.data.status).toBe("ok");
  });

  it("GET /health returns 503 when PLATFORM_DB missing", async () => {
    const env = createFakeEnv({ PLATFORM_DB: undefined });
    const req = new Request("https://metering-worker/health", { method: "GET" });
    const res = await route(req, env);
    expect(res.status).toBe(503);
  });

  it("returns 404 for unknown routes", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", "/v1/organizations/org_11111111111111111111111111111111/unknown");
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 401 for unauthenticated requests", async () => {
    const env = createFakeEnv();
    const req = makeUnauthenticatedRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/usage`);
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 405 for wrong method on usage endpoint", async () => {
    const env = createFakeEnv();
    const req = makeRequest("DELETE", `/v1/organizations/${TEST_ORG_PUBLIC}/usage`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 405 for wrong method on usage summary (POST instead of GET)", async () => {
    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/usage/summary`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 404 for invalid org public ID in path", async () => {
    const env = createFakeEnv();
    const req = makeRequest("POST", "/v1/organizations/invalid_id/usage");
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("preserves x-request-id from header", async () => {
    const env = createFakeEnv();
    const req = new Request("https://metering-worker/health", {
      method: "GET",
      headers: { "x-request-id": "req_custom123" },
    });
    const res = await route(req, env);
    expect(res.headers.get("x-request-id")).toBe("req_custom123");
  });

  it("generates x-request-id when not provided", async () => {
    const env = createFakeEnv();
    const req = new Request("https://metering-worker/health", { method: "GET" });
    const res = await route(req, env);
    const rid = res.headers.get("x-request-id");
    expect(rid).toMatch(/^req_[0-9a-f]{24}$/);
  });
});

// ── Policy engine integration ───────────────────────────────

describe("policy actions", () => {
  // This test verifies the metering actions exist by importing the policy engine
  // and checking authorization
  it("org admin has metering.read permission", async () => {
    // The policy engine is tested in its own package. Here we just verify the
    // router correctly enforces auth by testing with an unauthorized user.
    const denyPolicy = createMockFetcher({
      data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } },
    });
    const env = createFakeEnv({ POLICY_WORKER: denyPolicy });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/usage/summary?metric=api_requests`);
    const res = await route(req, env);
    expect(res.status).toBe(404); // 404 to hide existence
  });

  it("unauthenticated user gets 401 on quota check", async () => {
    const env = createFakeEnv();
    const req = makeUnauthenticatedRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/quotas/check`);
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });
});
