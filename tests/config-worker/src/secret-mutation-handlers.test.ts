import { handleCreateSecret } from "@config-worker/handlers/create-secret";
import { handleRotateSecret } from "@config-worker/handlers/rotate-secret";
import { handleRevokeSecret } from "@config-worker/handlers/revoke-secret";
import { parseSecretMetadataPublicId, secretMetadataPublicId } from "@config-worker/ids";
import { route } from "@config-worker/router";
import type { Env } from "@config-worker/env";
import type { ActorContext } from "@config-worker/router";
import type { Scope, SecretMetadata, ConfigResult, CreateSecretMetadataInput } from "@saas/db/config";
import type {
  AppendEventWithAuditInput,
  EventsResult,
  StoredEvent,
  StoredAuditEntry,
} from "@saas/db/events";

// ── Local types ────────────────────────────────────────────
type SecretView = {
  id: string;
  secretKey: string;
  status: string;
  version: number;
  value?: unknown;
  plaintext?: unknown;
  ciphertext?: unknown;
  ciphertextEnvelope?: unknown;
  hash?: unknown;
};
type ErrorEnvelope = {
  code: string;
  message?: string;
  details?: { fields?: Record<string, unknown> };
};
type JsonResp = {
  data: { secret: SecretView };
  error: ErrorEnvelope;
};

type EventPayload = {
  operation?: string;
  key?: string;
  value?: unknown;
  plaintext?: unknown;
  ciphertext?: unknown;
  hash?: unknown;
  [k: string]: unknown;
};

const unusedConfigFailure = <T>(): Promise<ConfigResult<T>> =>
  Promise.resolve({ ok: false, error: { kind: "internal", message: "unused stub" } });

const PLACEHOLDER_EVENT: StoredEvent = {
  id: "evt_placeholder",
  type: "test.placeholder",
  version: 1,
  source: "config-worker-tests",
  occurredAt: new Date("2026-05-01T00:00:00Z"),
  actorType: "user",
  actorId: "usr_aabbccdd",
  actorSessionId: null,
  actorIp: null,
  orgId: "11111111-1111-1111-1111-111111111111",
  projectId: null,
  environmentId: null,
  subjectKind: "test",
  subjectId: "placeholder",
  subjectName: null,
  requestId: "req_placeholder",
  correlationId: null,
  causationId: null,
  idempotencyKey: null,
  payload: {},
  redactPaths: [],
  createdAt: new Date("2026-05-01T00:00:00Z"),
};

const PLACEHOLDER_AUDIT: StoredAuditEntry = {
  id: "aud_placeholder",
  eventId: "evt_placeholder",
  orgId: "11111111-1111-1111-1111-111111111111",
  projectId: null,
  environmentId: null,
  actorType: "user",
  actorId: "usr_aabbccdd",
  eventType: "test.placeholder",
  eventVersion: 1,
  source: "config-worker-tests",
  subjectKind: "test",
  subjectId: "placeholder",
  subjectName: null,
  category: "test",
  description: "placeholder",
  occurredAt: new Date("2026-05-01T00:00:00Z"),
  requestId: "req_placeholder",
  correlationId: null,
  payload: {},
  redactPaths: [],
  createdAt: new Date("2026-05-01T00:00:00Z"),
};

// ── Constants ──────────────────────────────────────────────
const TEST_ORG_UUID = "11111111-1111-1111-1111-111111111111";
const TEST_PROJECT_UUID = "22222222-2222-2222-2222-222222222222";
const TEST_ENV_UUID = "44444444-4444-4444-4444-444444444444";
// Public actor id `usr_<32 hex>` decodes to TEST_USER_UUID for the
// created_by UUID column.
const TEST_USER_ID = "usr_" + "ab".repeat(16);
const TEST_USER_UUID = "abababab-abab-abab-abab-abababababab";
const FIXED_NOW = new Date("2026-05-01T00:00:00Z");
const FIXED_ID = "deadbeef01234567";
const SECRET_UUID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const ACTOR: ActorContext = { subjectId: TEST_USER_ID, subjectType: "user" };
const ORG_SCOPE: Scope = { kind: "organization", orgId: TEST_ORG_UUID };
const PRJ_SCOPE: Scope = { kind: "project", orgId: TEST_ORG_UUID, projectId: TEST_PROJECT_UUID };
const ENV_SCOPE: Scope = { kind: "environment", orgId: TEST_ORG_UUID, projectId: TEST_PROJECT_UUID, environmentId: TEST_ENV_UUID };

const FAKE_ENV = {} as Env;

const TEST_ORG_PUBLIC = "org_11111111111111111111111111111111";
const TEST_PRJ_PUBLIC = "prj_22222222222222222222222222222222";
const TEST_ENV_PUBLIC = "env_44444444444444444444444444444444";

function makeJsonRequest(body: unknown, method = "POST"): Request {
  return new Request("https://config-worker/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeBadRequest(): Request {
  return new Request("https://config-worker/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
}

function makeEmptyRequest(method = "POST"): Request {
  return new Request("https://config-worker/test", { method });
}

function makeDeleteRequest(): Request {
  return new Request("https://config-worker/test", { method: "DELETE" });
}

// ── Fake SecretMetadata ──────────────────────────────────────
function fakeSecret(overrides?: Partial<SecretMetadata>): SecretMetadata {
  return {
    id: SECRET_UUID,
    orgId: TEST_ORG_UUID,
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    secretKey: "API_KEY",
    displayName: "API Key",
    status: "active",
    version: 1,
    rotationPolicy: null,
    lastRotatedAt: null,
    expiresAt: null,
    createdBy: TEST_USER_ID,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

// ── Fake repos ─────────────────────────────────────────────
type FakeEventsRepo = {
  calls: AppendEventWithAuditInput[];
  appendEventWithAudit: (
    input: AppendEventWithAuditInput,
  ) => Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>>;
};

function fakeEventsRepo(): FakeEventsRepo {
  const calls: AppendEventWithAuditInput[] = [];
  return {
    calls,
    appendEventWithAudit(input) {
      calls.push(input);
      return Promise.resolve({
        ok: true as const,
        value: { event: PLACEHOLDER_EVENT, audit: PLACEHOLDER_AUDIT },
      });
    },
  };
}

function failingEventsRepo(): FakeEventsRepo {
  const calls: AppendEventWithAuditInput[] = [];
  return {
    calls,
    appendEventWithAudit(_input) {
      return Promise.resolve({ ok: false as const, error: { kind: "internal" as const, message: "event store down" } });
    },
  };
}

// ═══════════════════════════════════════════════════════════
// handleCreateSecret tests
// ═══════════════════════════════════════════════════════════
describe("handleCreateSecret", () => {
  it("returns 400 for invalid JSON", async () => {
    const res = await handleCreateSecret(makeBadRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
    });
    expect(res.status).toBe(400);
  });

  it("returns 422 for missing secretKey", async () => {
    const res = await handleCreateSecret(makeJsonRequest({ displayName: "test" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as JsonResp;
    expect(body.error.details?.fields?.secretKey).toBeDefined();
  });

  it("returns 422 for invalid secretKey pattern", async () => {
    const res = await handleCreateSecret(makeJsonRequest({ secretKey: "123bad" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
    });
    expect(res.status).toBe(422);
  });

  it("rejects secret material fields (value, plaintext, secret, ciphertext, hash, etc.)", async () => {
    // NOTE: "value" is now accepted for write-only encrypted storage (task-0065)
    const forbiddenFields = ["plaintext", "secret", "ciphertext", "ciphertextEnvelope", "ciphertext_envelope", "hash", "token", "password", "credential"];
    for (const field of forbiddenFields) {
      const body = { secretKey: "API_KEY", [field]: "should_be_rejected" };
      const res = await handleCreateSecret(makeJsonRequest(body), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
      });
      expect(res.status).toBe(422);
      const respBody = (await res.json()) as JsonResp;
      expect(respBody.error.details?.fields?.[field]).toBeDefined();
    }
  });

  it("creates secret metadata successfully", async () => {
    const secret = fakeSecret();
    const eventsRepo = fakeEventsRepo();
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY", displayName: "API Key" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: secret }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { secret: { secretKey: string; id: string; status: string } } };
    expect(body.data.secret.secretKey).toBe("API_KEY");
    expect(body.data.secret.id).toMatch(/^sec_/);
    expect(body.data.secret.status).toBe("active");
    expect(eventsRepo.calls).toHaveLength(1);
  });

  it("decodes the public actor id to a UUID for created_by", async () => {
    let captured: CreateSecretMetadataInput | undefined;
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: (input: CreateSecretMetadataInput) => {
            captured = input;
            return Promise.resolve({ ok: true as const, value: fakeSecret() });
          },
        },
        eventsRepo: fakeEventsRepo(),
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(201);
    // created_by is a UUID column — must be the decoded form, not `usr_...`.
    expect(captured?.createdBy).toBe(TEST_USER_UUID);
  });

  it("returns 422 for a malformed actor id", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY" }),
      FAKE_ENV, "req1", { subjectId: "usr_short", subjectType: "user" }, ORG_SCOPE,
      {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
        eventsRepo: fakeEventsRepo(),
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(422);
  });

  it("returns 409 on conflict", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "dup.key" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: false as const, error: { kind: "conflict" as const, entity: "secret_metadata" } }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(409);
  });

  it("event payload contains metadata only, no secret material", async () => {
    const secret = fakeSecret();
    const eventsRepo = fakeEventsRepo();
    await handleCreateSecret(
      makeJsonRequest({ secretKey: "DB_PASSWORD", displayName: "DB Pass" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: secret }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    const eventCall = eventsRepo.calls[0]!;
    const payload = eventCall.event.payload as EventPayload;
    expect(payload.operation).toBe("create");
    expect(payload.key).toBe("DB_PASSWORD");
    // Ensure no secret material in event
    expect(payload.value).toBeUndefined();
    expect(payload.plaintext).toBeUndefined();
    expect(payload.ciphertext).toBeUndefined();
    expect(payload.hash).toBeUndefined();
    // Ensure audit description is safe
    const auditDesc = eventCall.audit.description;
    expect(auditDesc).toContain("DB_PASSWORD");
    expect(auditDesc).not.toContain("secret_value");
  });

  it("returns 503 when event append fails", async () => {
    const secret = fakeSecret();
    const eventsRepo = failingEventsRepo();
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: secret }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(503);
  });

  it("response never contains plaintext/ciphertext/hash fields", async () => {
    const secret = fakeSecret();
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: secret }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    const body = (await res.json()) as JsonResp;
    const s = body.data.secret;
    expect(s.value).toBeUndefined();
    expect(s.plaintext).toBeUndefined();
    expect(s.ciphertext).toBeUndefined();
    expect(s.ciphertextEnvelope).toBeUndefined();
    expect(s.hash).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// handleRotateSecret tests
// ═══════════════════════════════════════════════════════════
describe("handleRotateSecret", () => {
  it("rotates secret metadata successfully", async () => {
    const existing = fakeSecret();
    const rotated = fakeSecret({ version: 2, lastRotatedAt: FIXED_NOW });
    const eventsRepo = fakeEventsRepo();
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: existing }),
          rotateSecretMetadata: () => Promise.resolve({ ok: true as const, value: rotated }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { secret: { version: number } } };
    expect(body.data.secret.version).toBe(2);
    expect(eventsRepo.calls).toHaveLength(1);
    const eventCall = eventsRepo.calls[0]!;
    expect((eventCall.event.payload as EventPayload).operation).toBe("rotate");
  });

  it("returns 404 when secret not found", async () => {
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when org route targets project-scoped secret (scope mismatch)", async () => {
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: projectSecret }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when project route targets org-scoped secret", async () => {
    const orgSecret = fakeSecret();
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: orgSecret }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when project route has mismatched projectId", async () => {
    const OTHER_PROJECT = "33333333-3333-3333-3333-333333333333";
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: OTHER_PROJECT });
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: projectSecret }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when environment route targets project-scoped secret", async () => {
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, ENV_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: projectSecret }),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("rejects secret material in rotate request body", async () => {
    // NOTE: "value" is now accepted for write-only encrypted storage (task-0065).
    // Test with a different forbidden field instead.
    const res = await handleRotateSecret(
      makeJsonRequest({ plaintext: "new_secret_value" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(422);
  });

  it("succeeds when project route matches project-scoped secret", async () => {
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const rotated = fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID, version: 2 });
    const eventsRepo = fakeEventsRepo();
    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: projectSecret }),
          rotateSecretMetadata: () => Promise.resolve({ ok: true as const, value: rotated }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════
// handleRevokeSecret tests
// ═══════════════════════════════════════════════════════════
describe("handleRevokeSecret", () => {
  it("revokes secret metadata successfully", async () => {
    const existing = fakeSecret();
    const revoked = fakeSecret({ status: "revoked" });
    const eventsRepo = fakeEventsRepo();
    const res = await handleRevokeSecret(
      makeDeleteRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: existing }),
          revokeSecretMetadata: () => Promise.resolve({ ok: true as const, value: revoked }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { secret: { status: string } } };
    expect(body.data.secret.status).toBe("revoked");
    expect(eventsRepo.calls).toHaveLength(1);
    const eventCall = eventsRepo.calls[0]!;
    expect(eventCall.event.payload.operation).toBe("revoke");
  });

  it("returns 404 when secret not found", async () => {
    const res = await handleRevokeSecret(
      makeDeleteRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } }),
          revokeSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when org route targets project-scoped secret", async () => {
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const res = await handleRevokeSecret(
      makeDeleteRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: projectSecret }),
          revokeSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when project route has mismatched projectId", async () => {
    const OTHER_PROJECT = "33333333-3333-3333-3333-333333333333";
    const projectSecret = fakeSecret({ scopeKind: "project", projectId: OTHER_PROJECT });
    const res = await handleRevokeSecret(
      makeDeleteRequest(), FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: projectSecret }),
          revokeSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
      },
    );
    expect(res.status).toBe(404);
  });

  it("event payload is safe (no secret material)", async () => {
    const existing = fakeSecret();
    const revoked = fakeSecret({ status: "revoked" });
    const eventsRepo = fakeEventsRepo();
    await handleRevokeSecret(
      makeDeleteRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: existing }),
          revokeSecretMetadata: () => Promise.resolve({ ok: true as const, value: revoked }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    const eventCall = eventsRepo.calls[0]!;
    expect(eventCall.event.payload.operation).toBe("revoke");
    expect(eventCall.event.payload.key).toBe("API_KEY");
    expect(eventCall.event.payload.value).toBeUndefined();
    expect(eventCall.event.payload.plaintext).toBeUndefined();
    expect(eventCall.event.subjectKind).toBe("secret");
  });
});

// ═══════════════════════════════════════════════════════════
// parseSecretMetadataPublicId tests
// ═══════════════════════════════════════════════════════════
describe("parseSecretMetadataPublicId", () => {
  it("parses valid sec_ ID", () => {
    const uuid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const publicId = secretMetadataPublicId(uuid);
    expect(parseSecretMetadataPublicId(publicId)).toBe(uuid);
  });

  it("returns null for wrong prefix", () => {
    expect(parseSecretMetadataPublicId("stg_cccccccccccccccccccccccccccccccc")).toBeNull();
  });

  it("returns null for malformed hex", () => {
    expect(parseSecretMetadataPublicId("sec_xyz")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// Router integration tests for secret routes
// ═══════════════════════════════════════════════════════════
describe("config-worker router - secret mutations", () => {
  const SECRET_PUBLIC = secretMetadataPublicId(SECRET_UUID);

  function routerRequest(path: string, method: string, body?: unknown): Request {
    const init: RequestInit = {
      method,
      headers: {
        "x-request-id": "req_test",
        "x-actor-subject-id": TEST_USER_ID,
        "x-actor-subject-type": "user",
      },
    };
    if (body !== undefined) {
      (init.headers as Record<string, string>)["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return new Request(`https://config-worker${path}`, init);
  }

  // POST create
  it("routes POST to org secrets (create) — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets`, "POST", { secretKey: "API_KEY" });
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("routes POST to project secrets (create) — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/config/secrets`, "POST", { secretKey: "API_KEY" });
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("routes POST to environment secrets (create) — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/environments/${TEST_ENV_PUBLIC}/config/secrets`, "POST", { secretKey: "API_KEY" });
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  // POST rotate
  it("routes POST to org secret rotate — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}/rotate`, "POST");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("routes POST to project secret rotate — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/config/secrets/${SECRET_PUBLIC}/rotate`, "POST");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("routes POST to environment secret rotate — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/environments/${TEST_ENV_PUBLIC}/config/secrets/${SECRET_PUBLIC}/rotate`, "POST");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  // DELETE revoke
  it("routes DELETE to org secret (revoke) — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}`, "DELETE");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("routes DELETE to project secret (revoke) — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/config/secrets/${SECRET_PUBLIC}`, "DELETE");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  it("routes DELETE to environment secret (revoke) — returns 503 without DB", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PRJ_PUBLIC}/environments/${TEST_ENV_PUBLIC}/config/secrets/${SECRET_PUBLIC}`, "DELETE");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(503);
  });

  // Method restrictions
  it("returns 405 for GET on secret item route", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}`, "GET");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(405);
  });

  it("returns 405 for PATCH on secret item route", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}`, "PATCH");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(405);
  });

  it("returns 405 for GET on rotate route", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}/rotate`, "GET");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(405);
  });

  it("returns 404 for malformed secret ID in route", async () => {
    const req = routerRequest(`/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/bad_id`, "DELETE");
    const res = await route(req, {} as Env);
    expect(res.status).toBe(404);
  });

  it("returns 401 for DELETE without actor headers", async () => {
    const req = new Request(
      `https://config-worker/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets/${SECRET_PUBLIC}`,
      { method: "DELETE" },
    );
    const res = await route(req, {} as Env);
    expect(res.status).toBe(401);
  });
});
