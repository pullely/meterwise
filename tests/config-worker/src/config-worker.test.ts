import { route } from "@config-worker/router";
import type { Env } from "@config-worker/env";
import { encodeCursor, decodeCursor, parsePageParams } from "@config-worker/pagination";
import {
  generateRequestId,
  parseOrgPublicId,
  parseProjectPublicId,
  parseEnvironmentPublicId,
  orgPublicId,
  settingPublicId,
  featureFlagPublicId,
  secretMetadataPublicId,
} from "@config-worker/ids";
import {
  toPublicSetting,
  toPublicFeatureFlag,
  toPublicSecretMetadata,
} from "@config-worker/mappers";
import type { Setting, FeatureFlag, SecretMetadata } from "@saas/db/config";

// ── Test constants ──────────────────────────────────────────
const TEST_ORG_UUID = "11111111-1111-1111-1111-111111111111";
const TEST_ORG_PUBLIC = "org_11111111111111111111111111111111";
const TEST_PROJECT_UUID = "22222222-2222-2222-2222-222222222222";
const TEST_PROJECT_PUBLIC = "prj_22222222222222222222222222222222";
const TEST_ENVIRONMENT_UUID = "33333333-3333-3333-3333-333333333333";
const TEST_ENVIRONMENT_PUBLIC = "env_33333333333333333333333333333333";
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

function createMockFetcherThatThrows(): Fetcher {
  return {
    fetch(): Promise<Response> {
      return Promise.reject(new Error("network error"));
    },
    connect() { throw new Error("not implemented"); },
  } as unknown as Fetcher;
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
  return new Request(`https://config-worker${path}`, {
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
  return new Request(`https://config-worker${path}`, {
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

  it("parseEnvironmentPublicId round-trips correctly", () => {
    expect(parseEnvironmentPublicId(TEST_ENVIRONMENT_PUBLIC)).toBe(TEST_ENVIRONMENT_UUID);
  });

  it("settingPublicId generates stg_ prefix", () => {
    const id = settingPublicId(TEST_ORG_UUID);
    expect(id).toMatch(/^stg_[0-9a-f]{32}$/);
  });

  it("featureFlagPublicId generates flg_ prefix", () => {
    const id = featureFlagPublicId(TEST_ORG_UUID);
    expect(id).toMatch(/^flg_[0-9a-f]{32}$/);
  });

  it("secretMetadataPublicId generates sec_ prefix", () => {
    const id = secretMetadataPublicId(TEST_ORG_UUID);
    expect(id).toMatch(/^sec_[0-9a-f]{32}$/);
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

  it("parsePageParams defaults to limit 50 and no cursor", () => {
    const url = new URL("https://x/v1/test");
    const result = parsePageParams(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.limit).toBe(50);
      expect(result.value.cursor).toBeNull();
    }
  });

  it("parsePageParams validates limit range", () => {
    const url = new URL("https://x/v1/test?limit=0");
    const result = parsePageParams(url);
    expect(result.ok).toBe(false);
  });

  it("parsePageParams validates limit over max", () => {
    const url = new URL("https://x/v1/test?limit=101");
    const result = parsePageParams(url);
    expect(result.ok).toBe(false);
  });

  it("parsePageParams accepts valid limit", () => {
    const url = new URL("https://x/v1/test?limit=25");
    const result = parsePageParams(url);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.limit).toBe(25);
    }
  });

  it("parsePageParams rejects invalid cursor", () => {
    const url = new URL("https://x/v1/test?cursor=garbage");
    const result = parsePageParams(url);
    expect(result.ok).toBe(false);
  });
});

// ── mappers.ts tests ────────────────────────────────────────

describe("mappers", () => {
  const baseDates = {
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T00:00:00Z"),
  };

  it("toPublicSetting maps correctly", () => {
    const setting: Setting = {
      id: TEST_ORG_UUID,
      orgId: TEST_ORG_UUID,
      projectId: TEST_PROJECT_UUID,
      environmentId: null,
      scopeKind: "project",
      key: "max_users",
      value: 100,
      description: "Max users",
      ...baseDates,
    };
    const pub = toPublicSetting(setting);
    expect(pub.id).toMatch(/^stg_/);
    expect(pub.orgId).toMatch(/^org_/);
    expect(pub.projectId).toMatch(/^prj_/);
    expect(pub.environmentId).toBeNull();
    expect(pub.key).toBe("max_users");
    expect(pub.value).toBe(100);
    expect(pub.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("toPublicFeatureFlag maps correctly", () => {
    const flag: FeatureFlag = {
      id: TEST_ORG_UUID,
      orgId: TEST_ORG_UUID,
      projectId: null,
      environmentId: null,
      scopeKind: "organization",
      flagKey: "dark_mode",
      enabled: true,
      value: null,
      description: "Dark mode",
      ...baseDates,
    };
    const pub = toPublicFeatureFlag(flag);
    expect(pub.id).toMatch(/^flg_/);
    expect(pub.orgId).toMatch(/^org_/);
    expect(pub.projectId).toBeNull();
    expect(pub.flagKey).toBe("dark_mode");
    expect(pub.enabled).toBe(true);
  });

  it("toPublicSecretMetadata maps correctly and excludes secrets", () => {
    const secret: SecretMetadata = {
      id: TEST_ORG_UUID,
      orgId: TEST_ORG_UUID,
      projectId: TEST_PROJECT_UUID,
      environmentId: TEST_ENVIRONMENT_UUID,
      scopeKind: "environment",
      secretKey: "API_KEY",
      displayName: "Main API Key",
      status: "active",
      version: 3,
      rotationPolicy: "90d",
      lastRotatedAt: new Date("2026-03-01T00:00:00Z"),
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      createdBy: TEST_USER_ID,
      ...baseDates,
    };
    const pub = toPublicSecretMetadata(secret);
    expect(pub.id).toMatch(/^sec_/);
    expect(pub.orgId).toMatch(/^org_/);
    expect(pub.projectId).toMatch(/^prj_/);
    expect(pub.environmentId).toMatch(/^env_/);
    expect(pub.secretKey).toBe("API_KEY");
    expect(pub.version).toBe(3);
    expect(pub.lastRotatedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(pub.expiresAt).toBe("2026-06-01T00:00:00.000Z");
    // Ensure no secret material fields
    const keys = Object.keys(pub);
    expect(keys).not.toContain("plaintext");
    expect(keys).not.toContain("ciphertext_envelope");
    expect(keys).not.toContain("hash");
    expect(keys).not.toContain("token");
  });

  it("toPublicSecretMetadata handles null dates", () => {
    const secret: SecretMetadata = {
      id: TEST_ORG_UUID,
      orgId: TEST_ORG_UUID,
      projectId: null,
      environmentId: null,
      scopeKind: "organization",
      secretKey: "DB_PASS",
      displayName: null,
      status: "active",
      version: 1,
      rotationPolicy: null,
      lastRotatedAt: null,
      expiresAt: null,
      createdBy: TEST_USER_ID,
      ...baseDates,
    };
    const pub = toPublicSecretMetadata(secret);
    expect(pub.lastRotatedAt).toBeNull();
    expect(pub.expiresAt).toBeNull();
    expect(pub.displayName).toBeNull();
    expect(pub.rotationPolicy).toBeNull();
  });
});

// ── Router tests ────────────────────────────────────────────

describe("config-worker router", () => {
  it("returns health check", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", "/health");
    const res = await route(req, env);
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { service: string } };
    expect(json.data.service).toBe("config-worker");
  });

  it("returns 404 for unknown routes", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", "/v1/unknown");
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 404 for malformed org public ID", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", "/v1/organizations/bad_id/config/settings");
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 405 for DELETE on config routes", async () => {
    const env = createFakeEnv();
    const req = makeRequest("DELETE", `/v1/organizations/${TEST_ORG_PUBLIC}/config/feature-flags`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 405 for PUT on config routes", async () => {
    const env = createFakeEnv();
    const req = makeRequest("PUT", `/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 401 for missing actor on org settings", async () => {
    const env = createFakeEnv();
    const req = makeUnauthenticatedRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/settings`);
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 for missing actor on org feature-flags", async () => {
    const env = createFakeEnv();
    const req = makeUnauthenticatedRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/feature-flags`);
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 for missing actor on org secrets", async () => {
    const env = createFakeEnv();
    const req = makeUnauthenticatedRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets`);
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 for missing actor on project-scoped settings", async () => {
    const env = createFakeEnv();
    const req = makeUnauthenticatedRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/config/settings`);
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 for missing actor on environment-scoped feature-flags", async () => {
    const env = createFakeEnv();
    const req = makeUnauthenticatedRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments/${TEST_ENVIRONMENT_PUBLIC}/config/feature-flags`);
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 404 for malformed project public ID", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/bad_id/config/settings`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 404 for malformed environment public ID", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments/bad_id/config/settings`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  // Route matching for all 9 endpoints × 3 scopes
  it("matches org settings route", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/settings`);
    const res = await route(req, env);
    // Will get 503 because PLATFORM_DB is a fake object, but route matched (not 404)
    expect([200, 503]).toContain(res.status);
  });

  it("matches org feature-flags route", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/feature-flags`);
    const res = await route(req, env);
    expect([200, 503]).toContain(res.status);
  });

  it("matches org secrets route", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets`);
    const res = await route(req, env);
    expect([200, 503]).toContain(res.status);
  });

  it("matches project settings route", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/config/settings`);
    const res = await route(req, env);
    expect([200, 503]).toContain(res.status);
  });

  it("matches project feature-flags route", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/config/feature-flags`);
    const res = await route(req, env);
    expect([200, 503]).toContain(res.status);
  });

  it("matches project secrets route", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/config/secrets`);
    const res = await route(req, env);
    expect([200, 503]).toContain(res.status);
  });

  it("matches environment settings route", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments/${TEST_ENVIRONMENT_PUBLIC}/config/settings`);
    const res = await route(req, env);
    expect([200, 503]).toContain(res.status);
  });

  it("matches environment feature-flags route", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments/${TEST_ENVIRONMENT_PUBLIC}/config/feature-flags`);
    const res = await route(req, env);
    expect([200, 503]).toContain(res.status);
  });

  it("matches environment secrets route", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments/${TEST_ENVIRONMENT_PUBLIC}/config/secrets`);
    const res = await route(req, env);
    expect([200, 503]).toContain(res.status);
  });

  // Service unavailability tests
  it("returns 503 when PLATFORM_DB is missing", async () => {
    const env = createFakeEnv({ PLATFORM_DB: undefined });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/settings`);
    const res = await route(req, env);
    expect(res.status).toBe(503);
  });

  it("returns 503 when MEMBERSHIP_WORKER is missing", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: undefined });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/settings`);
    const res = await route(req, env);
    expect(res.status).toBe(503);
  });

  it("returns 503 when POLICY_WORKER is missing", async () => {
    const env = createFakeEnv({ POLICY_WORKER: undefined });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/settings`);
    const res = await route(req, env);
    expect(res.status).toBe(503);
  });

  // Auth fail-closed tests
  it("fails closed when membership-context call fails", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcherThatThrows() });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/settings`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("fails closed when membership returns non-ok", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcher({}, 500) });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/feature-flags`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("fails closed when membership returns malformed envelope", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcher({ something: "wrong" }) });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("fails closed when policy denies", async () => {
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "denied", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/settings`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("fails closed when policy-worker fetch throws", async () => {
    const env = createFakeEnv({ POLICY_WORKER: createMockFetcherThatThrows() });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/feature-flags`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  // PERF14b: the list handlers emit Server-Timing phases; the parallel
  // authz_ctx/db pair (PERF12b) must be visible even on non-200 paths.
  it("deny path still carries Server-Timing phases (PERF14b)", async () => {
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "denied", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/settings`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
    const timing = res.headers.get("Server-Timing");
    expect(timing).toBeTruthy();
    for (const phase of ["authz_ctx", "db", "policy", "total"]) {
      expect(timing).toContain(phase);
    }
  });

  it("read-failure path still carries Server-Timing phases (PERF14b)", async () => {
    // Fake DB connection string -> the read resolves not-ok -> 503 with timings.
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets`);
    const res = await route(req, env);
    if (res.status === 503) {
      const timing = res.headers.get("Server-Timing");
      expect(timing).toBeTruthy();
      expect(timing).toContain("authz_ctx");
      expect(timing).toContain("total");
    } else {
      // Environment with a reachable DB: success must carry timings too.
      expect(res.status).toBe(200);
      expect(res.headers.get("Server-Timing")).toBeTruthy();
    }
  });

  it("fails closed when policy returns malformed envelope", async () => {
    const env = createFakeEnv({ POLICY_WORKER: createMockFetcher({ wrong: "shape" }) });
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  // Request ID handling
  it("uses x-request-id header when provided", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", "/health", { "x-request-id": "req_custom123" });
    const res = await route(req, env);
    const json = await res.json() as { meta: { requestId: string } };
    expect(json.meta.requestId).toBe("req_custom123");
  });

  it("generates request ID when header is missing", async () => {
    const env = createFakeEnv();
    const req = new Request("https://config-worker/health", {
      method: "GET",
    });
    const res = await route(req, env);
    const json = await res.json() as { meta: { requestId: string } };
    expect(json.meta.requestId).toMatch(/^req_/);
  });

  it("generates request ID when header is invalid", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", "/health", { "x-request-id": "x".repeat(200) });
    const res = await route(req, env);
    const json = await res.json() as { meta: { requestId: string } };
    expect(json.meta.requestId).toMatch(/^req_/);
    expect(json.meta.requestId).not.toBe("x".repeat(200));
  });
});
