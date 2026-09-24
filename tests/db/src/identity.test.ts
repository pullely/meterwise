import {
  createIdentityRepository,
} from "@saas/db/identity";
import { asUuid } from "@saas/db";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";

const ORG_UUID = asUuid("00000000-0000-4000-8000-000000000001");
const USER_UUID = asUuid("00000000-0000-4000-8000-000000000002");
const PROJECT_UUID = asUuid("00000000-0000-4000-8000-000000000003");
const REVOKER_UUID = asUuid("00000000-0000-4000-8000-000000000004");

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
const FUTURE = new Date("2099-01-15T11:00:00Z");
const PAST = new Date("2020-01-15T09:00:00Z");

const SAMPLE_USER_ROW = {
  id: "u-001",
  email: "Test@Example.com",
  email_lower: "test@example.com",
  display_name: "Test User",
  status: "active",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_AUTH_IDENTITY_ROW = {
  id: "ai-001",
  user_id: "u-001",
  provider: "email",
  subject: "test@example.com",
  metadata: {},
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_CHALLENGE_ROW = {
  id: "ch-001",
  user_id: "u-001",
  method: "email_code",
  expires_at: FUTURE.toISOString(),
  consumed_at: null,
  created_at: NOW.toISOString(),
};

const SAMPLE_SESSION_ROW = {
  id: "sess-001",
  user_id: "u-001",
  expires_at: FUTURE.toISOString(),
  revoked_at: null,
  created_at: NOW.toISOString(),
  last_seen_at: NOW.toISOString(),
};

const SAMPLE_SECURITY_EVENT_ROW = {
  id: "se-001",
  event_type: "login.completed",
  outcome: "success",
  user_id: "u-001",
  session_id: "sess-001",
  challenge_id: "ch-001",
  request_id: "req-001",
  correlation_id: "cor-001",
  ip: "192.168.1.1",
  user_agent: "Mozilla/5.0",
  occurred_at: NOW.toISOString(),
  created_at: NOW.toISOString(),
  metadata: JSON.stringify({ provider: "email" }),
  redact_paths: JSON.stringify(["/metadata/provider"]),
};

describe("IdentityRepository", () => {
  describe("createUser", () => {
    it("uses parameterized query for user creation", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_USER_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.createUser({
        id: "u-001",
        email: "Test@Example.com",
        emailLower: "test@example.com",
        displayName: "Test User",
        createdAt: NOW,
      });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.text).toContain("$2");
      expect(queries[0]!.text).toContain("$3");
      expect(queries[0]!.params).toEqual([
        "u-001",
        "Test@Example.com",
        "test@example.com",
        "Test User",
        NOW.toISOString(),
      ]);
    });

    it("maps returned row to User type", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_USER_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.createUser({
        id: "u-001",
        email: "Test@Example.com",
        emailLower: "test@example.com",
        createdAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("u-001");
        expect(result.value.email).toBe("Test@Example.com");
        expect(result.value.emailLower).toBe("test@example.com");
        expect(result.value.status).toBe("active");
        expect(result.value.createdAt).toEqual(NOW);
      }
    });

    it("returns conflict on duplicate user", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createIdentityRepository(executor);

      const result = await repo.createUser({
        id: "u-001",
        email: "Test@Example.com",
        emailLower: "test@example.com",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("conflict");
      }
    });

    it("returns conflict on unique violation error code", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("D1_ERROR: UNIQUE constraint failed"),
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.createUser({
        id: "u-001",
        email: "Test@Example.com",
        emailLower: "test@example.com",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("conflict");
      }
    });

    it("maps generic errors to safe internal error", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("connection to host 10.0.0.1:5432 refused"),
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.createUser({
        id: "u-001",
        email: "a@b.com",
        emailLower: "a@b.com",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal");
        expect((result.error as { kind: "internal"; message: string }).message).not.toContain("10.0.0.1");
        expect((result.error as { kind: "internal"; message: string }).message).not.toContain("5432");
      }
    });
  });

  describe("getUserById", () => {
    it("uses parameterized query for lookup", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_USER_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.getUserById("u-001");

      expect(queries[0]!.params).toEqual(["u-001"]);
      expect(queries[0]!.text).toContain("$1");
    });

    it("returns not_found when no rows", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createIdentityRepository(executor);

      const result = await repo.getUserById("u-missing");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("getUserByEmail", () => {
    it("uses normalized email in parameterized query", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_USER_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.getUserByEmail("test@example.com");

      expect(queries[0]!.params).toEqual(["test@example.com"]);
      expect(queries[0]!.text).toContain("email_lower");
    });

    it("returns not_found for unknown email", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createIdentityRepository(executor);

      const result = await repo.getUserByEmail("unknown@example.com");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("createAuthIdentity", () => {
    it("uses parameterized query", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_AUTH_IDENTITY_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.createAuthIdentity({
        id: "ai-001",
        userId: "u-001",
        provider: "email",
        subject: "test@example.com",
        createdAt: NOW,
      });

      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.params[2]).toBe("email");
      expect(queries[0]!.params[3]).toBe("test@example.com");
    });

    it("returns conflict on duplicate provider+subject", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("D1_ERROR: UNIQUE constraint failed"),
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.createAuthIdentity({
        id: "ai-002",
        userId: "u-001",
        provider: "email",
        subject: "test@example.com",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("conflict");
    });
  });

  describe("getAuthIdentityByProviderSubject", () => {
    it("uses parameterized query with provider and subject", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_AUTH_IDENTITY_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.getAuthIdentityByProviderSubject("email", "test@example.com");

      expect(queries[0]!.params).toEqual(["email", "test@example.com"]);
    });

    it("returns not_found for unknown provider+subject", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createIdentityRepository(executor);

      const result = await repo.getAuthIdentityByProviderSubject("oauth", "unknown");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("createLoginChallenge", () => {
    it("stores hashed code via parameterized query", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_CHALLENGE_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.createLoginChallenge({
        id: "ch-001",
        userId: "u-001",
        method: "email_code",
        codeHash: "sha256-hashed-code",
        expiresAt: FUTURE,
        createdAt: NOW,
      });

      expect(queries[0]!.params[3]).toBe("sha256-hashed-code");
      expect(queries[0]!.text).toContain("$4");
    });
  });

  describe("getLoginChallengeById", () => {
    it("returns challenge for valid unconsumed challenge", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_CHALLENGE_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.getLoginChallengeById("ch-001");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("ch-001");
        expect(result.value).not.toHaveProperty("codeHash");
      }
    });

    it("returns already_consumed for consumed challenge", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_CHALLENGE_ROW, consumed_at: NOW.toISOString() }],
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.getLoginChallengeById("ch-001");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("already_consumed");
    });

    it("returns expired for expired challenge", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_CHALLENGE_ROW, expires_at: PAST.toISOString() }],
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.getLoginChallengeById("ch-001");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("expired");
    });

    it("returns not_found for missing challenge", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createIdentityRepository(executor);

      const result = await repo.getLoginChallengeById("ch-missing");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("consumeLoginChallenge", () => {
    it("uses parameterized update with code_hash and consumed_at IS NULL guard", async () => {
      const { executor, queries } = createFakeExecutor({
        rows: [{ ...SAMPLE_CHALLENGE_ROW, consumed_at: NOW.toISOString() }],
      });
      const repo = createIdentityRepository(executor);

      await repo.consumeLoginChallenge("ch-001", "sha256-hashed-code", NOW);

      expect(queries[0]!.text).toContain("code_hash = $2");
      expect(queries[0]!.text).toContain("consumed_at IS NULL");
      expect(queries[0]!.params).toEqual(["ch-001", "sha256-hashed-code", NOW.toISOString()]);
    });

    it("returns already_consumed when no rows affected", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createIdentityRepository(executor);

      const result = await repo.consumeLoginChallenge("ch-001", "sha256-hashed-code", NOW);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("already_consumed");
    });

    it("does not expose codeHash in returned challenge", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_CHALLENGE_ROW, consumed_at: NOW.toISOString() }],
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.consumeLoginChallenge("ch-001", "sha256-hashed-code", NOW);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toHaveProperty("codeHash");
      }
    });
  });

  describe("createSession", () => {
    it("stores hashed token via parameterized query", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SESSION_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.createSession({
        id: "sess-001",
        userId: "u-001",
        tokenHash: "sha256-hashed-token",
        expiresAt: FUTURE,
        createdAt: NOW,
      });

      expect(queries[0]!.params[2]).toBe("sha256-hashed-token");
      expect(queries[0]!.text).toContain("$3");
    });

    it("returns conflict on duplicate token hash", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("D1_ERROR: UNIQUE constraint failed"),
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.createSession({
        id: "sess-002",
        userId: "u-001",
        tokenHash: "sha256-hashed-token",
        expiresAt: FUTURE,
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("conflict");
    });
  });

  describe("getSessionByTokenHash", () => {
    it("uses parameterized query with token hash", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SESSION_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.getSessionByTokenHash("sha256-hashed-token");

      expect(queries[0]!.params).toEqual(["sha256-hashed-token"]);
      expect(queries[0]!.text).toContain("revoked_at IS NULL");
    });

    it("returns not_found for unknown token hash", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createIdentityRepository(executor);

      const result = await repo.getSessionByTokenHash("unknown-hash");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });

    it("returns expired for expired session", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_SESSION_ROW, expires_at: PAST.toISOString() }],
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.getSessionByTokenHash("sha256-hashed-token");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("expired");
    });

    it("does not expose tokenHash in returned session", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_SESSION_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.getSessionByTokenHash("sha256-hashed-token");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toHaveProperty("tokenHash");
      }
    });
  });

  describe("getSessionWithUserByTokenHash (PERF12d JOIN)", () => {
    const SAMPLE_JOINED_ROW = {
      // session columns, aliased as the JOIN selects them
      session_id: "sess-001",
      session_user_id: "u-001",
      session_expires_at: FUTURE.toISOString(),
      session_revoked_at: null,
      session_created_at: NOW.toISOString(),
      session_last_seen_at: NOW.toISOString(),
      // the joined `u.*` user columns (id: "u-001", email, created_at, …)
      ...SAMPLE_USER_ROW,
    };

    it("JOINs sessions to users in one parameterized query", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_JOINED_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.getSessionWithUserByTokenHash("sha256-hashed-token");

      expect(queries[0]!.params).toEqual(["sha256-hashed-token"]);
      expect(queries[0]!.text).toContain("JOIN identity_users");
      expect(queries[0]!.text).toContain("revoked_at IS NULL");
    });

    it("splits the joined row into session + user with no column collision", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_JOINED_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.getSessionWithUserByTokenHash("sha256-hashed-token");

      expect(result.ok).toBe(true);
      if (result.ok) {
        // session.id must come from session_id, NOT the user's id ("u-001").
        expect(result.value.session.id).toBe("sess-001");
        expect(result.value.session.userId).toBe("u-001");
        expect(result.value.user.id).toBe("u-001");
        expect(result.value.user.email).toBe("Test@Example.com");
        expect(result.value.session).not.toHaveProperty("tokenHash");
      }
    });

    it("returns not_found for unknown token hash", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createIdentityRepository(executor);

      const result = await repo.getSessionWithUserByTokenHash("unknown-hash");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });

    it("returns expired for an expired session", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_JOINED_ROW, session_expires_at: PAST.toISOString() }],
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.getSessionWithUserByTokenHash("sha256-hashed-token");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("expired");
    });
  });

  describe("revokeSession", () => {
    it("uses parameterized update with revoked_at IS NULL guard", async () => {
      const { executor, queries } = createFakeExecutor({
        rows: [{ ...SAMPLE_SESSION_ROW, revoked_at: NOW.toISOString() }],
      });
      const repo = createIdentityRepository(executor);

      await repo.revokeSession("sess-001", NOW);

      expect(queries[0]!.text).toContain("revoked_at IS NULL");
      expect(queries[0]!.params).toEqual(["sess-001", NOW.toISOString()]);
    });

    it("returns not_found when session already revoked", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createIdentityRepository(executor);

      const result = await repo.revokeSession("sess-001", NOW);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("safe error handling", () => {
    it("never exposes raw SQL errors in repository outputs", async () => {
      const pgError = new Error(
        'relation "identity_users" does not exist at character 15',
      );
      const { executor } = createFakeExecutor({ error: pgError });
      const repo = createIdentityRepository(executor);

      const result = await repo.getUserById("u-001");

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "internal") {
        expect(result.error.message).not.toContain("relation");
        expect(result.error.message).not.toContain("character 15");
      }
    });

    it("never exposes connection strings in errors", async () => {
      const connError = new Error(
        "could not connect to postgres://admin:secret@db.internal:5432/prod",
      );
      const { executor } = createFakeExecutor({ error: connError });
      const repo = createIdentityRepository(executor);

      const result = await repo.createUser({
        id: "u-001",
        email: "a@b.com",
        emailLower: "a@b.com",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "internal") {
        expect(result.error.message).not.toContain("admin");
        expect(result.error.message).not.toContain("secret");
        expect(result.error.message).not.toContain("db.internal");
      }
    });

    it("never exposes token hashes in error outputs", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("duplicate key value (token_hash)=(abc123secret)"),
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.createSession({
        id: "sess-001",
        userId: "u-001",
        tokenHash: "abc123secret",
        expiresAt: FUTURE,
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const serialized = JSON.stringify(result.error);
        expect(serialized).not.toContain("abc123secret");
      }
    });
  });

  describe("Worker-safe import isolation", () => {
    it("does not import runner-only modules", async () => {
      const mod = await import("@saas/db/identity");
      const exportKeys = Object.keys(mod);

      expect(exportKeys).toContain("createIdentityRepository");
      expect(exportKeys).not.toContain("runMigrations");
      expect(exportKeys).not.toContain("D1ApiAdapter");
      expect(exportKeys).not.toContain("loadD1CredentialsFromEnv");
    });
  });

  describe("recordSecurityEvent", () => {
    it("uses parameterized query for insert", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECURITY_EVENT_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.recordSecurityEvent({
        id: "se-001",
        eventType: "login.completed",
        outcome: "success",
        userId: "u-001",
        sessionId: "sess-001",
        challengeId: "ch-001",
        requestId: "req-001",
        correlationId: "cor-001",
        ip: "192.168.1.1",
        userAgent: "Mozilla/5.0",
        occurredAt: NOW,
        metadata: { provider: "email" },
        redactPaths: ["/metadata/provider"],
      });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.text).toContain("$13");
      expect(queries[0]!.text).toContain("identity_security_events");
      expect(queries[0]!.params[0]).toBe("se-001");
      expect(queries[0]!.params[1]).toBe("login.completed");
      expect(queries[0]!.params[2]).toBe("success");
      expect(queries[0]!.params[3]).toBe("u-001");
    });

    it("maps returned row to SecurityEvent type", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_SECURITY_EVENT_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.recordSecurityEvent({
        id: "se-001",
        eventType: "login.completed",
        outcome: "success",
        occurredAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("se-001");
        expect(result.value.eventType).toBe("login.completed");
        expect(result.value.outcome).toBe("success");
        expect(result.value.userId).toBe("u-001");
        expect(result.value.sessionId).toBe("sess-001");
        expect(result.value.challengeId).toBe("ch-001");
        expect(result.value.ip).toBe("192.168.1.1");
        expect(result.value.occurredAt).toEqual(NOW);
        expect(result.value.createdAt).toEqual(NOW);
      }
    });

    it("serializes metadata as JSON", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECURITY_EVENT_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.recordSecurityEvent({
        id: "se-001",
        eventType: "login.completed",
        outcome: "success",
        metadata: { provider: "email", extra: 42 },
      });

      const metadataParam = queries[0]!.params[11];
      expect(typeof metadataParam).toBe("string");
      expect(JSON.parse(metadataParam as string)).toEqual({ provider: "email", extra: 42 });
    });

    it("parses JSONB metadata from returned row", async () => {
      const { executor } = createFakeExecutor({
        rows: [{ ...SAMPLE_SECURITY_EVENT_ROW, metadata: JSON.stringify({ deep: { nested: true } }) }],
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.recordSecurityEvent({
        id: "se-001",
        eventType: "login.completed",
        outcome: "success",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata).toEqual({ deep: { nested: true } });
      }
    });

    it("parses redact_paths from returned row", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_SECURITY_EVENT_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.recordSecurityEvent({
        id: "se-001",
        eventType: "login.completed",
        outcome: "success",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.redactPaths).toEqual(["/metadata/provider"]);
      }
    });

    it("defaults nullable fields to null", async () => {
      const { executor, queries } = createFakeExecutor({
        rows: [{
          ...SAMPLE_SECURITY_EVENT_ROW,
          user_id: null,
          session_id: null,
          challenge_id: null,
          ip: null,
          user_agent: null,
          correlation_id: null,
        }],
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.recordSecurityEvent({
        id: "se-002",
        eventType: "login.started",
        outcome: "pending",
      });

      expect(queries[0]!.params[3]).toBeNull();
      expect(queries[0]!.params[4]).toBeNull();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBeNull();
        expect(result.value.sessionId).toBeNull();
        expect(result.value.challengeId).toBeNull();
        expect(result.value.ip).toBeNull();
        expect(result.value.userAgent).toBeNull();
      }
    });

    it("returns conflict on unique violation", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("D1_ERROR: UNIQUE constraint failed"),
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.recordSecurityEvent({
        id: "se-001",
        eventType: "login.completed",
        outcome: "success",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("conflict");
    });

    it("maps generic errors to safe internal error", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("connection to host 10.0.0.1:5432 refused"),
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.recordSecurityEvent({
        id: "se-001",
        eventType: "login.completed",
        outcome: "success",
      });

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "internal") {
        expect(result.error.message).not.toContain("10.0.0.1");
        expect(result.error.message).not.toContain("5432");
        expect(result.error.message).toBe("Failed to record security event");
      }
    });

    it("does not store raw secret values in params", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECURITY_EVENT_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.recordSecurityEvent({
        id: "se-001",
        eventType: "login.completed",
        outcome: "success",
        metadata: { safe_field: "visible" },
      });

      const allParams = JSON.stringify(queries[0]!.params);
      expect(allParams).not.toContain("token_hash");
      expect(allParams).not.toContain("code_hash");
      expect(allParams).not.toContain("bearer_token");
    });
  });

  describe("querySecurityEventsByUser", () => {
    it("uses parameterized query with user_id", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECURITY_EVENT_ROW] });
      const repo = createIdentityRepository(executor);

      await repo.querySecurityEventsByUser({
        userId: "u-001",
        limit: 10,
        cursor: null,
      });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("user_id = $1");
      expect(queries[0]!.params[0]).toBe("u-001");
      expect(queries[0]!.params[1]).toBe(11);
    });

    it("returns items with correct mapping", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_SECURITY_EVENT_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.querySecurityEventsByUser({
        userId: "u-001",
        limit: 10,
        cursor: null,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(1);
        expect(result.value.items[0]!.id).toBe("se-001");
        expect(result.value.items[0]!.eventType).toBe("login.completed");
      }
    });

    it("orders by occurred_at DESC, id DESC", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [] });
      const repo = createIdentityRepository(executor);

      await repo.querySecurityEventsByUser({
        userId: "u-001",
        limit: 10,
        cursor: null,
      });

      expect(queries[0]!.text).toContain("ORDER BY occurred_at DESC, id DESC");
    });

    it("returns null nextCursor when items fit within limit", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_SECURITY_EVENT_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.querySecurityEventsByUser({
        userId: "u-001",
        limit: 10,
        cursor: null,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.nextCursor).toBeNull();
      }
    });

    it("returns nextCursor when more items exist (limit+1 pattern)", async () => {
      const rows = [
        { ...SAMPLE_SECURITY_EVENT_ROW, id: "se-001", occurred_at: "2026-01-15T10:03:00Z" },
        { ...SAMPLE_SECURITY_EVENT_ROW, id: "se-002", occurred_at: "2026-01-15T10:02:00Z" },
        { ...SAMPLE_SECURITY_EVENT_ROW, id: "se-003", occurred_at: "2026-01-15T10:01:00Z" },
      ];
      const { executor } = createFakeExecutor({ rows });
      const repo = createIdentityRepository(executor);

      const result = await repo.querySecurityEventsByUser({
        userId: "u-001",
        limit: 2,
        cursor: null,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(2);
        expect(result.value.nextCursor).not.toBeNull();
        expect(result.value.nextCursor!.id).toBe("se-002");
        expect(result.value.nextCursor!.occurredAt).toBe(new Date("2026-01-15T10:02:00Z").toISOString());
      }
    });

    it("applies cursor filter with tuple comparison", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [] });
      const repo = createIdentityRepository(executor);

      await repo.querySecurityEventsByUser({
        userId: "u-001",
        limit: 10,
        cursor: { occurredAt: "2026-01-15T10:00:00Z", id: "se-005" },
      });

      expect(queries[0]!.text).toContain("(occurred_at, id) < ($3, $4)");
      expect(queries[0]!.params[2]).toBe("2026-01-15T10:00:00Z");
      expect(queries[0]!.params[3]).toBe("se-005");
    });

    it("maps generic errors to safe internal error", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("relation does not exist"),
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.querySecurityEventsByUser({
        userId: "u-001",
        limit: 10,
        cursor: null,
      });

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "internal") {
        expect(result.error.message).toBe("Failed to query security events");
        expect(result.error.message).not.toContain("relation");
      }
    });
  });

  describe("security event secret safety", () => {
    it("never includes secret columns in security event type", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_SECURITY_EVENT_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.recordSecurityEvent({
        id: "se-001",
        eventType: "login.completed",
        outcome: "success",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const serialized = JSON.stringify(result.value);
        expect(serialized).not.toContain("tokenHash");
        expect(serialized).not.toContain("codeHash");
        expect(serialized).not.toContain("bearerToken");
        expect(serialized).not.toContain("apiKey");
        expect(result.value).not.toHaveProperty("tokenHash");
        expect(result.value).not.toHaveProperty("codeHash");
        expect(result.value).not.toHaveProperty("bearerToken");
        expect(result.value).not.toHaveProperty("secret");
      }
    });

    it("never exposes secrets in error output for security events", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("duplicate key value (token_hash)=(abc123secret)"),
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.recordSecurityEvent({
        id: "se-001",
        eventType: "login.completed",
        outcome: "success",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const serialized = JSON.stringify(result.error);
        expect(serialized).not.toContain("abc123secret");
        expect(serialized).not.toContain("token_hash");
      }
    });
  });

  // --- Service Principal Tests ---

  const SAMPLE_SERVICE_PRINCIPAL_ROW = {
    id: "sp-001",
    org_id: ORG_UUID,
    project_id: null,
    display_name: "CI Pipeline",
    description: "Continuous integration automation",
    status: "active",
    created_by: USER_UUID,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };

  describe("createServicePrincipal", () => {
    it("inserts into identity_service_principals with correct params", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SERVICE_PRINCIPAL_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.createServicePrincipal({
        id: "sp-001",
        orgId: ORG_UUID,
        displayName: "CI Pipeline",
        description: "Continuous integration automation",
        createdBy: USER_UUID,
        createdAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("sp-001");
        expect(result.value.orgId).toBe(ORG_UUID);
        expect(result.value.projectId).toBeNull();
        expect(result.value.displayName).toBe("CI Pipeline");
      }
      expect(queries.length).toBe(1);
      expect(queries[0]!.text).toContain("identity_service_principals");
      expect(queries[0]!.text).toContain("INSERT INTO");
    });

    it("supports project-scoped service principals", async () => {
      const projectRow = { ...SAMPLE_SERVICE_PRINCIPAL_ROW, project_id: PROJECT_UUID };
      const { executor } = createFakeExecutor({ rows: [projectRow] });
      const repo = createIdentityRepository(executor);

      const result = await repo.createServicePrincipal({
        id: "sp-001",
        orgId: ORG_UUID,
        projectId: PROJECT_UUID,
        displayName: "CI Pipeline",
        createdBy: USER_UUID,
        createdAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.projectId).toBe(PROJECT_UUID);
      }
    });

    it("returns conflict on duplicate id", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createIdentityRepository(executor);

      const result = await repo.createServicePrincipal({
        id: "sp-001",
        orgId: ORG_UUID,
        displayName: "CI Pipeline",
        createdBy: USER_UUID,
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("conflict");
      }
    });

    it("handles unique violation", async () => {
      const { executor } = createFakeExecutor({ error: new Error("D1_ERROR: UNIQUE constraint failed") });
      const repo = createIdentityRepository(executor);

      const result = await repo.createServicePrincipal({
        id: "sp-001",
        orgId: ORG_UUID,
        displayName: "CI Pipeline",
        createdBy: USER_UUID,
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("conflict");
      }
    });
  });

  describe("getServicePrincipalById", () => {
    it("returns service principal by id", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_SERVICE_PRINCIPAL_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.getServicePrincipalById("sp-001");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("sp-001");
        expect(result.value.orgId).toBe(ORG_UUID);
      }
    });

    it("filters out deleted service principals", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createIdentityRepository(executor);

      const result = await repo.getServicePrincipalById("sp-001");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("not_found");
      }
      expect(queries[0]!.text).toContain("status != 'deleted'");
    });
  });

  describe("listServicePrincipalsByOrg", () => {
    it("lists service principals for org, excluding deleted", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SERVICE_PRINCIPAL_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.listServicePrincipalsByOrg("org-001");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]!.orgId).toBe(ORG_UUID);
      }
      expect(queries[0]!.text).toContain("status != 'deleted'");
      expect(queries[0]!.text).toContain("ORDER BY created_at DESC");
    });
  });

  // --- API Key Tests ---

  const SAMPLE_API_KEY_ROW = {
    id: "ak-001",
    service_principal_id: "sp-001",
    org_id: ORG_UUID,
    key_prefix: "spk_abc1",
    label: "Production CI key",
    status: "active",
    expires_at: FUTURE.toISOString(),
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    created_by: USER_UUID,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };

  describe("createApiKey", () => {
    it("inserts into identity_api_keys with correct params", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_API_KEY_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.createApiKey({
        id: "ak-001",
        servicePrincipalId: "sp-001",
        orgId: ORG_UUID,
        keyPrefix: "spk_abc1",
        keyHash: "sha256hashvalue",
        label: "Production CI key",
        expiresAt: FUTURE,
        createdBy: USER_UUID,
        createdAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("ak-001");
        expect(result.value.servicePrincipalId).toBe("sp-001");
        expect(result.value.orgId).toBe(ORG_UUID);
        expect(result.value.keyPrefix).toBe("spk_abc1");
        expect(result.value.label).toBe("Production CI key");
        expect(result.value.status).toBe("active");
      }
      expect(queries.length).toBe(1);
      expect(queries[0]!.text).toContain("identity_api_keys");
      expect(queries[0]!.text).toContain("key_hash");
      // CRITICAL: key_hash must NOT appear in RETURNING clause
      expect(queries[0]!.text.split("RETURNING")[1]).not.toContain("key_hash");
    });

    it("never returns key_hash in the created API key", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_API_KEY_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.createApiKey({
        id: "ak-001",
        servicePrincipalId: "sp-001",
        orgId: ORG_UUID,
        keyPrefix: "spk_abc1",
        keyHash: "sha256hashvalue",
        createdBy: USER_UUID,
        createdAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const serialized = JSON.stringify(result.value);
        expect(serialized).not.toContain("keyHash");
        expect(serialized).not.toContain("key_hash");
        expect(serialized).not.toContain("sha256hashvalue");
        expect(result.value).not.toHaveProperty("keyHash");
        expect(result.value).not.toHaveProperty("key_hash");
      }
    });

    it("returns conflict on duplicate id", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createIdentityRepository(executor);

      const result = await repo.createApiKey({
        id: "ak-001",
        servicePrincipalId: "sp-001",
        orgId: ORG_UUID,
        keyPrefix: "spk_abc1",
        keyHash: "sha256hashvalue",
        createdBy: USER_UUID,
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("conflict");
      }
    });
  });

  describe("getApiKeyByKeyHash", () => {
    it("returns active API key by hash", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_API_KEY_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.getApiKeyByKeyHash("sha256hashvalue");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("ak-001");
      }
      // Must filter by active status
      expect(queries[0]!.text).toContain("status = 'active'");
      // Must NOT return key_hash in SELECT
      expect(queries[0]!.text.split("FROM")[0]).not.toContain("key_hash");
    });

    it("returns not_found for missing/revoked key", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createIdentityRepository(executor);

      const result = await repo.getApiKeyByKeyHash("nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("not_found");
      }
    });
  });

  describe("listApiKeysByOrg", () => {
    it("lists API keys for org with cursor pagination", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_API_KEY_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.listApiKeysByOrg({ orgId: "org-001", limit: 50, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(1);
        expect(result.value.nextCursor).toBeNull();
      }
      expect(queries[0]!.text).toContain("org_id = $1");
      expect(queries[0]!.text).toContain("ORDER BY created_at DESC");
      // Must NOT return key_hash in SELECT
      expect(queries[0]!.text.split("FROM")[0]).not.toContain("key_hash");
    });

    it("uses cursor for pagination", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_API_KEY_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.listApiKeysByOrg({
        orgId: "org-001",
        limit: 50,
        cursor: { createdAt: NOW.toISOString(), id: "ak-000" },
      });

      expect(result.ok).toBe(true);
      expect(queries[0]!.text).toContain("(created_at, id) <");
    });

    it("returns nextCursor when more results exist", async () => {
      const rows = [
        { ...SAMPLE_API_KEY_ROW, id: "ak-001" },
        { ...SAMPLE_API_KEY_ROW, id: "ak-002" },
      ];
      const { executor } = createFakeExecutor({ rows });
      const repo = createIdentityRepository(executor);

      const result = await repo.listApiKeysByOrg({ orgId: "org-001", limit: 1, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(1);
        expect(result.value.nextCursor).not.toBeNull();
      }
    });
  });

  describe("revokeApiKey", () => {
    it("revokes an active API key", async () => {
      const revokedRow = { ...SAMPLE_API_KEY_ROW, status: "revoked", revoked_at: NOW.toISOString(), revoked_by: REVOKER_UUID };
      const { executor, queries } = createFakeExecutor({ rows: [revokedRow] });
      const repo = createIdentityRepository(executor);

      const result = await repo.revokeApiKey("ak-001", REVOKER_UUID, NOW);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("revoked");
        expect(result.value.revokedBy).toBe(REVOKER_UUID);
        expect(result.value.revokedAt).not.toBeNull();
      }
      expect(queries[0]!.text).toContain("status = 'active'");
      expect(queries[0]!.text).toContain("status = 'revoked'");
      // Must NOT return key_hash in RETURNING
      expect(queries[0]!.text.split("RETURNING")[1]).not.toContain("key_hash");
    });

    it("returns not_found for already-revoked key", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createIdentityRepository(executor);

      const result = await repo.revokeApiKey("ak-001", REVOKER_UUID, NOW);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("not_found");
      }
    });
  });

  describe("API key secret safety", () => {
    it("API key type never includes keyHash property", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_API_KEY_ROW] });
      const repo = createIdentityRepository(executor);

      const result = await repo.createApiKey({
        id: "ak-001",
        servicePrincipalId: "sp-001",
        orgId: ORG_UUID,
        keyPrefix: "spk_abc1",
        keyHash: "sha256hashvalue",
        createdBy: USER_UUID,
        createdAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const serialized = JSON.stringify(result.value);
        expect(serialized).not.toContain("keyHash");
        expect(serialized).not.toContain("key_hash");
        expect(serialized).not.toContain("secret");
        expect(serialized).not.toContain("bearerToken");
        expect(result.value).not.toHaveProperty("keyHash");
        expect(result.value).not.toHaveProperty("secret");
      }
    });

    it("never exposes secrets in error output for API keys", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("duplicate key value (key_hash)=(sha256secrethash)"),
      });
      const repo = createIdentityRepository(executor);

      const result = await repo.createApiKey({
        id: "ak-001",
        servicePrincipalId: "sp-001",
        orgId: ORG_UUID,
        keyPrefix: "spk_abc1",
        keyHash: "sha256secrethash",
        createdBy: USER_UUID,
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const serialized = JSON.stringify(result.error);
        expect(serialized).not.toContain("sha256secrethash");
        expect(serialized).not.toContain("key_hash");
      }
    });
  });
});
