/**
 * Tests for encrypted secret payload storage (Task 0065).
 *
 * Covers: encryption adapter, create-with-value, rotate-with-value,
 * secret-safety guarantees, encryption failure handling, and
 * backward-compatible metadata-only flows.
 */
import { createEncryptionAdapter } from "@config-worker/encryption";
import type { CiphertextEnvelope, EncryptionAdapter } from "@config-worker/encryption";
import { handleCreateSecret } from "@config-worker/handlers/create-secret";
import { handleRotateSecret } from "@config-worker/handlers/rotate-secret";
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
  ciphertext_envelope?: unknown;
  hash?: unknown;
};
type JsonResp = {
  data: { secret: SecretView };
};

type EventPayload = {
  operation?: string;
  key?: string;
  value?: unknown;
  plaintext?: unknown;
  ciphertext?: unknown;
  ciphertextEnvelope?: unknown;
  secret?: unknown;
  hash?: unknown;
  [k: string]: unknown;
};

const unusedConfigFailure = <T>(): Promise<ConfigResult<T>> =>
  Promise.resolve({ ok: false, error: { kind: "internal", message: "unused stub" } });

// ── Constants ──────────────────────────────────────────────
const TEST_ORG_UUID = "11111111-1111-1111-1111-111111111111";
const TEST_USER_ID = "usr_" + "ab".repeat(16);
const FIXED_NOW = new Date("2026-05-01T00:00:00Z");
const FIXED_ID = "deadbeef01234567";
const SECRET_UUID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
// 64 hex chars = 32 bytes = 256-bit key
const TEST_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const ACTOR: ActorContext = { subjectId: TEST_USER_ID, subjectType: "user" };
const ORG_SCOPE: Scope = { kind: "organization", orgId: TEST_ORG_UUID };
const FAKE_ENV = {} as Env;

const PLACEHOLDER_EVENT: StoredEvent = {
  id: "evt_placeholder",
  type: "test.placeholder",
  version: 1,
  source: "config-worker-tests",
  occurredAt: FIXED_NOW,
  actorType: "user",
  actorId: TEST_USER_ID,
  actorSessionId: null,
  actorIp: null,
  orgId: TEST_ORG_UUID,
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
  createdAt: FIXED_NOW,
};

const PLACEHOLDER_AUDIT: StoredAuditEntry = {
  id: "aud_placeholder",
  eventId: "evt_placeholder",
  orgId: TEST_ORG_UUID,
  projectId: null,
  environmentId: null,
  actorType: "user",
  actorId: TEST_USER_ID,
  eventType: "test.placeholder",
  eventVersion: 1,
  source: "config-worker-tests",
  subjectKind: "test",
  subjectId: "placeholder",
  subjectName: null,
  category: "test",
  description: "placeholder",
  occurredAt: FIXED_NOW,
  requestId: "req_placeholder",
  correlationId: null,
  payload: {},
  redactPaths: [],
  createdAt: FIXED_NOW,
};

function makeJsonRequest(body: unknown, method = "POST"): Request {
  return new Request("https://config-worker/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeEmptyRequest(method = "POST"): Request {
  return new Request("https://config-worker/test", { method });
}

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

// ── Fake encryption adapter ──────────────────────────────────
function fakeEncryptionAdapter(): EncryptionAdapter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async encrypt(plaintext: string): Promise<CiphertextEnvelope> {
      calls.push(plaintext);
      return {
        alg: "AES-256-GCM",
        v: 1,
        iv: "dGVzdGl2MTIzNDU2", // fake base64
        ct: "ZW5jcnlwdGVk",     // fake base64
      };
    },
  };
}

function failingEncryptionAdapter(): EncryptionAdapter {
  return {
    async encrypt(_plaintext: string): Promise<CiphertextEnvelope> {
      throw new Error("Encryption hardware failure");
    },
  };
}

// ═══════════════════════════════════════════════════════════
// Encryption adapter tests
// ═══════════════════════════════════════════════════════════
describe("createEncryptionAdapter", () => {
  it("returns null for undefined key", async () => {
    const adapter = await createEncryptionAdapter(undefined);
    expect(adapter).toBeNull();
  });

  it("returns null for empty string key", async () => {
    const adapter = await createEncryptionAdapter("");
    expect(adapter).toBeNull();
  });

  it("returns null for too-short hex key", async () => {
    const adapter = await createEncryptionAdapter("0123456789abcdef");
    expect(adapter).toBeNull();
  });

  it("returns null for non-hex key", async () => {
    const adapter = await createEncryptionAdapter("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz");
    expect(adapter).toBeNull();
  });

  it("creates adapter for valid 64-char hex key", async () => {
    const adapter = await createEncryptionAdapter(TEST_KEY_HEX);
    expect(adapter).not.toBeNull();
  });

  it("encrypts and produces a valid envelope", async () => {
    const adapter = await createEncryptionAdapter(TEST_KEY_HEX);
    expect(adapter).not.toBeNull();
    const envelope = await adapter!.encrypt("test-secret-value");

    expect(envelope.alg).toBe("AES-256-GCM");
    expect(envelope.v).toBe(1);
    expect(typeof envelope.iv).toBe("string");
    expect(envelope.iv.length).toBeGreaterThan(0);
    expect(typeof envelope.ct).toBe("string");
    expect(envelope.ct.length).toBeGreaterThan(0);
  });

  it("produces different IVs for different encryptions", async () => {
    const adapter = await createEncryptionAdapter(TEST_KEY_HEX);
    const e1 = await adapter!.encrypt("same-value");
    const e2 = await adapter!.encrypt("same-value");
    expect(e1.iv).not.toBe(e2.iv);
  });

  it("ciphertext does not contain plaintext", async () => {
    const adapter = await createEncryptionAdapter(TEST_KEY_HEX);
    const envelope = await adapter!.encrypt("my-super-secret");
    // Base64-decode ciphertext and check it doesn't contain plaintext
    const ctBytes = atob(envelope.ct);
    expect(ctBytes).not.toContain("my-super-secret");
  });
});

// ═══════════════════════════════════════════════════════════
// handleCreateSecret — write-only encrypted value tests
// ═══════════════════════════════════════════════════════════
describe("handleCreateSecret with value", () => {
  it("creates secret with encrypted value when adapter is provided", async () => {
    const secret = fakeSecret();
    const eventsRepo = fakeEventsRepo();
    const adapter = fakeEncryptionAdapter();
    let capturedInput: CreateSecretMetadataInput | null = null;

    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "DB_PASSWORD", value: "s3cret!" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: (input: CreateSecretMetadataInput) => {
            capturedInput = input;
            return Promise.resolve({ ok: true as const, value: secret });
          },
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
        encryptionAdapter: adapter,
      },
    );

    expect(res.status).toBe(201);
    // Verify encryption adapter was called with the plaintext value
    expect(adapter.calls).toEqual(["s3cret!"]);
    // Verify ciphertextEnvelope was passed to repository
    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.ciphertextEnvelope).toBeDefined();
    const envelope = JSON.parse(capturedInput!.ciphertextEnvelope!) as CiphertextEnvelope;
    expect(envelope.alg).toBe("AES-256-GCM");
    expect(envelope.v).toBe(1);
  });

  it("returns 503 when value is provided but encryption adapter is null", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "DB_PASSWORD", value: "s3cret!" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
        encryptionAdapter: null,
      },
    );
    expect(res.status).toBe(503);
  });

  it("returns 503 when encryption fails", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "DB_PASSWORD", value: "s3cret!" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
        encryptionAdapter: failingEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(503);
  });

  it("returns 422 for non-string value", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY", value: 12345 }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 for empty string value", async () => {
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY", value: "" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(422);
  });

  it("creates secret without value (metadata-only) when adapter is null", async () => {
    const secret = fakeSecret();
    let capturedInput: CreateSecretMetadataInput | null = null;

    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: (input: CreateSecretMetadataInput) => {
            capturedInput = input;
            return Promise.resolve({ ok: true as const, value: secret });
          },
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
        encryptionAdapter: null,
      },
    );

    expect(res.status).toBe(201);
    expect(capturedInput!.ciphertextEnvelope).toBeUndefined();
  });

  it("response never contains value/plaintext/ciphertext fields", async () => {
    const secret = fakeSecret();
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY", value: "s3cret!" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: secret }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    const body = (await res.json()) as JsonResp;
    const s = body.data.secret;
    expect(s.value).toBeUndefined();
    expect(s.plaintext).toBeUndefined();
    expect(s.ciphertext).toBeUndefined();
    expect(s.ciphertextEnvelope).toBeUndefined();
    expect(s.ciphertext_envelope).toBeUndefined();
    expect(s.hash).toBeUndefined();
  });

  it("event payload does not contain secret value or ciphertext", async () => {
    const secret = fakeSecret();
    const eventsRepo = fakeEventsRepo();
    await handleCreateSecret(
      makeJsonRequest({ secretKey: "DB_PASSWORD", value: "s3cret!" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: secret }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    const eventCall = eventsRepo.calls[0]!;
    const payload = eventCall.event.payload as EventPayload;
    expect(payload.operation).toBe("create");
    expect(payload.key).toBe("DB_PASSWORD");
    expect(payload.value).toBeUndefined();
    expect(payload.plaintext).toBeUndefined();
    expect(payload.ciphertext).toBeUndefined();
    expect(payload.ciphertextEnvelope).toBeUndefined();
    expect(payload.secret).toBeUndefined();
  });

  it("still rejects forbidden secret material fields except value", async () => {
    const forbidden = ["plaintext", "secret", "ciphertext", "ciphertextEnvelope", "ciphertext_envelope", "hash", "token", "password", "credential"];
    for (const field of forbidden) {
      const body = { secretKey: "API_KEY", [field]: "should_be_rejected" };
      const res = await handleCreateSecret(makeJsonRequest(body), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
        repo: { createSecretMetadata: () => unusedConfigFailure<SecretMetadata>() },
        encryptionAdapter: fakeEncryptionAdapter(),
      });
      expect(res.status).toBe(422);
    }
  });

  it("encryption failure aborts before DB mutation", async () => {
    let repoCallCount = 0;
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY", value: "s3cret!" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => {
            repoCallCount++;
            return Promise.resolve({ ok: true as const, value: fakeSecret() });
          },
        },
        encryptionAdapter: failingEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(503);
    expect(repoCallCount).toBe(0);
  });

  it("returns 503 when event append fails (with value)", async () => {
    const secret = fakeSecret();
    const eventsRepo = failingEventsRepo();
    const res = await handleCreateSecret(
      makeJsonRequest({ secretKey: "API_KEY", value: "s3cret!" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSecretMetadata: () => Promise.resolve({ ok: true as const, value: secret }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(503);
  });
});

// ═══════════════════════════════════════════════════════════
// handleRotateSecret — write-only encrypted value tests
// ═══════════════════════════════════════════════════════════
describe("handleRotateSecret with value", () => {
  it("rotates secret with encrypted value", async () => {
    const existing = fakeSecret();
    const rotated = fakeSecret({ version: 2, lastRotatedAt: FIXED_NOW });
    const eventsRepo = fakeEventsRepo();
    const adapter = fakeEncryptionAdapter();
    let capturedCiphertext: string | undefined;

    const res = await handleRotateSecret(
      makeJsonRequest({ value: "new-s3cret!" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: existing }),
          rotateSecretMetadata: (_orgId: string, _secretId: string, ciphertextEnvelope?: string) => {
            capturedCiphertext = ciphertextEnvelope;
            return Promise.resolve({ ok: true as const, value: rotated });
          },
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
        encryptionAdapter: adapter,
      },
    );

    expect(res.status).toBe(200);
    expect(adapter.calls).toEqual(["new-s3cret!"]);
    expect(capturedCiphertext).toBeDefined();
    const envelope = JSON.parse(capturedCiphertext!) as CiphertextEnvelope;
    expect(envelope.alg).toBe("AES-256-GCM");
    const body = await res.json() as { data: { secret: { version: number } } };
    expect(body.data.secret.version).toBe(2);
  });

  it("rotates secret without value (metadata-only) - backward compatible", async () => {
    const existing = fakeSecret();
    const rotated = fakeSecret({ version: 2, lastRotatedAt: FIXED_NOW });
    const eventsRepo = fakeEventsRepo();
    let capturedCiphertext: string | undefined;

    const res = await handleRotateSecret(
      makeEmptyRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: existing }),
          rotateSecretMetadata: (_orgId: string, _secretId: string, ciphertextEnvelope?: string) => {
            capturedCiphertext = ciphertextEnvelope;
            return Promise.resolve({ ok: true as const, value: rotated });
          },
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
        encryptionAdapter: null,
      },
    );

    expect(res.status).toBe(200);
    expect(capturedCiphertext).toBeUndefined();
  });

  it("returns 503 when value is provided but encryption is not configured", async () => {
    const res = await handleRotateSecret(
      makeJsonRequest({ value: "new-s3cret!" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
        encryptionAdapter: null,
      },
    );
    expect(res.status).toBe(503);
  });

  it("returns 503 when encryption fails during rotate", async () => {
    const res = await handleRotateSecret(
      makeJsonRequest({ value: "new-s3cret!" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
        encryptionAdapter: failingEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(503);
  });

  it("returns 422 for empty value string on rotate", async () => {
    const res = await handleRotateSecret(
      makeJsonRequest({ value: "" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 for non-string value on rotate", async () => {
    const res = await handleRotateSecret(
      makeJsonRequest({ value: 12345 }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(422);
  });

  it("still rejects forbidden fields on rotate", async () => {
    const forbidden = ["plaintext", "secret", "ciphertext", "ciphertextEnvelope", "ciphertext_envelope", "hash", "token", "password", "credential"];
    for (const field of forbidden) {
      const body = { [field]: "should_be_rejected" };
      const res = await handleRotateSecret(makeJsonRequest(body), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID, {
        repo: {
          getSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
          rotateSecretMetadata: () => unusedConfigFailure<SecretMetadata>(),
        },
        encryptionAdapter: fakeEncryptionAdapter(),
      });
      expect(res.status).toBe(422);
    }
  });

  it("response never contains value/ciphertext fields on rotate", async () => {
    const existing = fakeSecret();
    const rotated = fakeSecret({ version: 2 });
    const res = await handleRotateSecret(
      makeJsonRequest({ value: "new-s3cret!" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: existing }),
          rotateSecretMetadata: () => Promise.resolve({ ok: true as const, value: rotated }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    const body = (await res.json()) as JsonResp;
    const s = body.data.secret;
    expect(s.value).toBeUndefined();
    expect(s.plaintext).toBeUndefined();
    expect(s.ciphertext).toBeUndefined();
    expect(s.ciphertextEnvelope).toBeUndefined();
    expect(s.ciphertext_envelope).toBeUndefined();
    expect(s.hash).toBeUndefined();
  });

  it("event payload does not contain secret value or ciphertext on rotate", async () => {
    const existing = fakeSecret();
    const rotated = fakeSecret({ version: 2 });
    const eventsRepo = fakeEventsRepo();
    await handleRotateSecret(
      makeJsonRequest({ value: "new-s3cret!" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => Promise.resolve({ ok: true as const, value: existing }),
          rotateSecretMetadata: () => Promise.resolve({ ok: true as const, value: rotated }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
        encryptionAdapter: fakeEncryptionAdapter(),
      },
    );
    const eventCall = eventsRepo.calls[0]!;
    const payload = eventCall.event.payload as EventPayload;
    expect(payload.operation).toBe("rotate");
    expect(payload.value).toBeUndefined();
    expect(payload.plaintext).toBeUndefined();
    expect(payload.ciphertext).toBeUndefined();
    expect(payload.ciphertextEnvelope).toBeUndefined();
    expect(payload.secret).toBeUndefined();
  });

  it("encryption failure aborts before DB mutation on rotate", async () => {
    let getCallCount = 0;
    let rotateCallCount = 0;
    const res = await handleRotateSecret(
      makeJsonRequest({ value: "new-s3cret!" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SECRET_UUID,
      {
        repo: {
          getSecretMetadata: () => {
            getCallCount++;
            return Promise.resolve({ ok: true as const, value: fakeSecret() });
          },
          rotateSecretMetadata: () => {
            rotateCallCount++;
            return Promise.resolve({ ok: true as const, value: fakeSecret() });
          },
        },
        encryptionAdapter: failingEncryptionAdapter(),
      },
    );
    expect(res.status).toBe(503);
    // Encryption happens before any DB calls
    expect(getCallCount).toBe(0);
    expect(rotateCallCount).toBe(0);
  });
});
