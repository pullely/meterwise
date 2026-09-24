import { createFakeRepository } from "./helpers/fake-repository";
import crypto from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}
if (typeof globalThis.crypto.randomUUID !== "function") {
  (globalThis.crypto as unknown as { randomUUID: () => string }).randomUUID = () => crypto.randomUUID();
}

import { createAuthService } from "../../../apps/identity-worker/src/services/auth";
import {
  challengePublicId,
  parseChallengePublicId,
  parseSessionToken,
  buildSessionToken,
} from "../../../apps/identity-worker/src/ids";

const SECRET_PATTERNS = [
  /\d{6}/,
  /^[0-9a-f]{64}$/i,
  /^sps_ses_/,
];

function assertNoSecrets(metadata: Record<string, unknown>): void {
  const json = JSON.stringify(metadata);
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(json)) {
      const keys = Object.keys(metadata);
      const suspectKeys = ["code", "codeHash", "tokenHash", "tokenSecret", "secret", "apiKey", "token", "bearerToken"];
      for (const key of keys) {
        if (suspectKeys.includes(key)) {
          throw new Error(`Security event metadata contains suspect key: ${key}`);
        }
      }
    }
  }
}

describe("Auth Service", () => {
  const fixedNow = new Date("2026-01-15T10:00:00.000Z");

  describe("startLogin", () => {
    it("creates user and challenge for new email", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const result = await auth.startLogin("Test@Example.com");

      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.challengeId).toMatch(/^chl_[0-9a-f]{32}$/);
      expect(result.rawCode).toMatch(/^\d{6}$/);
      expect(result.emailHint).toBe("t***@example.com");
      expect(result.expiresAt.getTime()).toBe(fixedNow.getTime() + 10 * 60 * 1000);
      expect(repo._users.size).toBe(1);
      expect(repo._authIdentities.size).toBe(1);
    });

    it("stores UUID in repository, not prefixed public ID", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      await auth.startLogin("user@test.com");

      const userId = [...repo._users.keys()][0]!;
      expect(userId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const challengeId = [...repo._challenges.keys()][0]!;
      expect(challengeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("reuses existing user for known email", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      await auth.startLogin("user@test.com");
      const before = repo._users.size;
      await auth.startLogin("user@test.com");
      expect(repo._users.size).toBe(before);
    });

    it("generates unique codes across calls", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const r1 = await auth.startLogin("a@b.com");
      const r2 = await auth.startLogin("a@b.com");
      if ("error" in r1 || "error" in r2) return;
      expect(r1.challengeId).not.toBe(r2.challengeId);
    });

    it("stores code hash not raw code in challenge", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const result = await auth.startLogin("x@y.com");
      if ("error" in result) return;

      const challengeUuid = parseChallengePublicId(result.challengeId)!;
      const stored = repo._challenges.get(challengeUuid);
      expect(stored).toBeDefined();
      expect(stored!.codeHash).not.toBe(result.rawCode);
      expect(stored!.codeHash.length).toBe(64);
    });

    it("records login.challenge.created security event", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const result = await auth.startLogin("user@example.com");
      if ("error" in result) throw new Error("startLogin failed");

      expect(repo._securityEvents).toHaveLength(1);
      const event = repo._securityEvents[0]!;
      expect(event.eventType).toBe("login.challenge.created");
      expect(event.outcome).toBe("success");
    });

    it("security event contains userId and challengeId as UUIDs", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const result = await auth.startLogin("user@example.com");
      if ("error" in result) throw new Error("startLogin failed");

      const event = repo._securityEvents[0]!;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(event.userId).toMatch(uuidRe);
      expect(event.challengeId).toMatch(uuidRe);
      expect(event.userId).toBe([...repo._users.keys()][0]);
      expect(event.challengeId).toBe([...repo._challenges.keys()][0]);
    });

    it("security event metadata does not contain raw code", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const result = await auth.startLogin("user@example.com");
      if ("error" in result) throw new Error("startLogin failed");

      const event = repo._securityEvents[0]!;
      expect(event.metadata).toEqual({ method: "email_code" });
      assertNoSecrets(event.metadata);
      expect(JSON.stringify(event.metadata)).not.toContain(result.rawCode);
    });

    it("propagates request context to security event", async () => {
      const repo = createFakeRepository();
      const ctx = { requestId: "req_abc123", ip: "203.0.113.42", userAgent: "TestAgent/1.0" };
      const auth = createAuthService({ repo, now: () => fixedNow, ctx });
      const result = await auth.startLogin("user@example.com");
      if ("error" in result) throw new Error("startLogin failed");

      const event = repo._securityEvents[0]!;
      expect(event.requestId).toBe("req_abc123");
      expect(event.ip).toBe("203.0.113.42");
      expect(event.userAgent).toBe("TestAgent/1.0");
    });

    it("returns internal_error when event recording fails", async () => {
      const repo = createFakeRepository();
      repo.recordSecurityEvent = async () => ({ ok: false, error: { kind: "internal" as const, message: "db error" } });
      const auth = createAuthService({ repo, now: () => fixedNow });
      const result = await auth.startLogin("user@example.com");

      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("internal_error");
    });
  });

  describe("completeLogin", () => {
    it("consumes challenge and returns session token", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");

      const result = await auth.completeLogin(start.challengeId, start.rawCode);
      expect("error" in result).toBe(false);
      if ("error" in result) return;

      expect(result.token).toMatch(/^sps_ses_[0-9a-f]{32}\..+$/);
      expect(result.user.id).toMatch(/^usr_[0-9a-f]{32}$/);
      expect(result.user.email).toBe("user@example.com");
      expect(result.expiresAt.getTime()).toBe(fixedNow.getTime() + 30 * 24 * 60 * 60 * 1000);
    });

    it("stores UUID session in repository", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      await auth.completeLogin(start.challengeId, start.rawCode);

      const sessionId = [...repo._sessions.keys()][0]!;
      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("returns error for wrong code", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");

      const result = await auth.completeLogin(start.challengeId, "000000");
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("not_found");
    });

    it("returns error for already consumed challenge", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");

      await auth.completeLogin(start.challengeId, start.rawCode);
      const result = await auth.completeLogin(start.challengeId, start.rawCode);
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("precondition_failed");
      expect(result.message).toContain("already been used");
    });

    it("returns error for expired challenge", async () => {
      const repo = createFakeRepository();
      const expiredTime = new Date(fixedNow.getTime() + 11 * 60 * 1000);
      let currentTime = fixedNow;
      const auth = createAuthService({ repo, now: () => currentTime });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");

      currentTime = expiredTime;
      const result = await auth.completeLogin(start.challengeId, start.rawCode);
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("precondition_failed");
      expect(result.message).toContain("expired");
    });

    it("returns error for unknown challenge", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const result = await auth.completeLogin("chl_00000000000000000000000000000000", "123456");
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("not_found");
    });

    it("returns error for invalid challenge ID format", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const result = await auth.completeLogin("invalid_id", "123456");
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("not_found");
    });

    it("stores session token hash not raw token", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");

      const result = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in result) throw new Error("completeLogin failed");

      const parsed = parseSessionToken(result.token);
      expect(parsed).not.toBeNull();
      for (const s of repo._sessions.values()) {
        expect(s.tokenHash).not.toBe(parsed!.secret);
        expect(s.tokenHash.length).toBe(64);
      }
    });

    it("records session.created security event on success", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const result = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in result) throw new Error("completeLogin failed");

      const sessionEvent = repo._securityEvents.find((e) => e.eventType === "session.created");
      expect(sessionEvent).toBeDefined();
      expect(sessionEvent!.outcome).toBe("success");
    });

    it("session.created event contains userId, sessionId, and challengeId UUIDs", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      await auth.completeLogin(start.challengeId, start.rawCode);

      const event = repo._securityEvents.find((e) => e.eventType === "session.created")!;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(event.userId).toMatch(uuidRe);
      expect(event.sessionId).toMatch(uuidRe);
      expect(event.challengeId).toMatch(uuidRe);
      expect(event.userId).toBe([...repo._users.keys()][0]);
      expect(event.sessionId).toBe([...repo._sessions.keys()][0]);
    });

    it("session.created event metadata does not contain secrets", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const result = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in result) throw new Error("completeLogin failed");

      const event = repo._securityEvents.find((e) => e.eventType === "session.created")!;
      const json = JSON.stringify(event.metadata);
      expect(json).not.toContain(start.rawCode);
      expect(json).not.toContain(result.token);
      assertNoSecrets(event.metadata);
      expect(event.metadata).not.toHaveProperty("code");
      expect(event.metadata).not.toHaveProperty("codeHash");
      expect(event.metadata).not.toHaveProperty("tokenHash");
      expect(event.metadata).not.toHaveProperty("tokenSecret");
      expect(event.metadata).not.toHaveProperty("secret");
    });

    it("records login.complete.failed event for wrong code", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");

      await auth.completeLogin(start.challengeId, "000000");

      const failEvent = repo._securityEvents.find((e) => e.eventType === "login.complete.failed");
      expect(failEvent).toBeDefined();
      expect(failEvent!.outcome).toBe("invalid_code_or_challenge");
      expect(failEvent!.challengeId).toBe(parseChallengePublicId(start.challengeId));
    });

    it("records login.complete.failed event for expired challenge", async () => {
      const repo = createFakeRepository();
      let currentTime = fixedNow;
      const auth = createAuthService({ repo, now: () => currentTime });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");

      currentTime = new Date(fixedNow.getTime() + 11 * 60 * 1000);
      await auth.completeLogin(start.challengeId, start.rawCode);

      const failEvent = repo._securityEvents.find((e) => e.eventType === "login.complete.failed");
      expect(failEvent).toBeDefined();
      expect(failEvent!.outcome).toBe("expired_challenge");
    });

    it("records login.complete.failed event for already consumed challenge", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");

      await auth.completeLogin(start.challengeId, start.rawCode);
      await auth.completeLogin(start.challengeId, start.rawCode);

      const failEvents = repo._securityEvents.filter((e) => e.eventType === "login.complete.failed");
      expect(failEvents).toHaveLength(1);
      expect(failEvents[0]!.outcome).toBe("already_consumed");
    });

    it("records login.complete.failed event for invalid challenge format", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      await auth.completeLogin("invalid_id", "123456");

      const failEvent = repo._securityEvents.find((e) => e.eventType === "login.complete.failed");
      expect(failEvent).toBeDefined();
      expect(failEvent!.outcome).toBe("invalid_challenge_format");
      expect(failEvent!.challengeId).toBeNull();
    });

    it("failed event metadata does not contain raw code or secrets", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");

      const wrongCode = "999999";
      await auth.completeLogin(start.challengeId, wrongCode);

      const failEvent = repo._securityEvents.find((e) => e.eventType === "login.complete.failed")!;
      const json = JSON.stringify(failEvent.metadata);
      expect(json).not.toContain(wrongCode);
      expect(json).not.toContain(start.rawCode);
      assertNoSecrets(failEvent.metadata);
      expect(failEvent.metadata).not.toHaveProperty("code");
      expect(failEvent.metadata).not.toHaveProperty("codeHash");
      expect(failEvent.metadata).not.toHaveProperty("tokenHash");
      expect(failEvent.metadata).not.toHaveProperty("secret");
    });

    it("propagates request context to security events", async () => {
      const repo = createFakeRepository();
      const ctx = { requestId: "req_xyz789", ip: "198.51.100.1", userAgent: "Mozilla/5.0" };
      const auth = createAuthService({ repo, now: () => fixedNow, ctx });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      await auth.completeLogin(start.challengeId, start.rawCode);

      for (const event of repo._securityEvents) {
        expect(event.requestId).toBe("req_xyz789");
        expect(event.ip).toBe("198.51.100.1");
        expect(event.userAgent).toBe("Mozilla/5.0");
      }
    });

    it("returns internal_error when session.created event recording fails", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");

      repo.recordSecurityEvent = async () => ({ ok: false, error: { kind: "internal" as const, message: "db error" } });

      const result = await auth.completeLogin(start.challengeId, start.rawCode);
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("internal_error");
    });
  });

  describe("getSession", () => {
    it("resolves valid session", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      const result = await auth.getSession(complete.token);
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.user.email).toBe("user@example.com");
      expect(result.user.id).toMatch(/^usr_[0-9a-f]{32}$/);
      expect(result.session.id).toMatch(/^ses_[0-9a-f]{32}$/);
    });

    it("returns unauthenticated for malformed token", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const result = await auth.getSession("not-a-valid-token");
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("unauthenticated");
    });

    it("returns unauthenticated for unknown token", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const result = await auth.getSession("sps_ses_00000000000000000000000000000000.deadbeef");
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("unauthenticated");
    });

    it("returns unauthenticated for expired session", async () => {
      const repo = createFakeRepository();
      let currentTime = fixedNow;
      const auth = createAuthService({ repo, now: () => currentTime });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      currentTime = new Date(fixedNow.getTime() + 31 * 24 * 60 * 60 * 1000);
      const result = await auth.getSession(complete.token);
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("unauthenticated");
      expect(result.message).toContain("expired");
    });

    it("returns unauthenticated for revoked session", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      await auth.logout(complete.token);
      const result = await auth.getSession(complete.token);
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("unauthenticated");
      expect(result.message).toContain("revoked");
    });

    it("does not record security events for read-only session check", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      const eventCountBefore = repo._securityEvents.length;
      await auth.getSession(complete.token);
      expect(repo._securityEvents.length).toBe(eventCountBefore);
    });
  });

  describe("logout", () => {
    it("revokes a valid session", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      const result = await auth.logout(complete.token);
      expect("error" in result).toBe(false);
      expect("success" in result && result.success).toBe(true);
    });

    it("is idempotent for already-revoked session", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      await auth.logout(complete.token);
      const result = await auth.logout(complete.token);
      expect("error" in result).toBe(false);
    });

    it("returns unauthenticated for invalid token", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const result = await auth.logout("garbage");
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("unauthenticated");
    });

    it("records session.revoked security event", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      await auth.logout(complete.token);

      const revokeEvent = repo._securityEvents.find((e) => e.eventType === "session.revoked");
      expect(revokeEvent).toBeDefined();
      expect(revokeEvent!.outcome).toBe("success");
    });

    it("session.revoked event contains userId and sessionId UUIDs", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      await auth.logout(complete.token);

      const event = repo._securityEvents.find((e) => e.eventType === "session.revoked")!;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(event.userId).toMatch(uuidRe);
      expect(event.sessionId).toMatch(uuidRe);
      expect(event.userId).toBe([...repo._users.keys()][0]);
      expect(event.sessionId).toBe([...repo._sessions.keys()][0]);
    });

    it("does not record duplicate event for already-revoked session", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      await auth.logout(complete.token);
      const countAfterFirst = repo._securityEvents.filter((e) => e.eventType === "session.revoked").length;
      await auth.logout(complete.token);
      const countAfterSecond = repo._securityEvents.filter((e) => e.eventType === "session.revoked").length;
      expect(countAfterSecond).toBe(countAfterFirst);
    });

    it("session.revoked event does not contain secrets", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      await auth.logout(complete.token);

      const event = repo._securityEvents.find((e) => e.eventType === "session.revoked")!;
      const json = JSON.stringify(event);
      expect(json).not.toContain(complete.token);
      expect(json).not.toContain(start.rawCode);
      expect(event.metadata).not.toHaveProperty("token");
      expect(event.metadata).not.toHaveProperty("tokenHash");
      expect(event.metadata).not.toHaveProperty("secret");
    });

    it("returns internal_error when event recording fails", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      repo.recordSecurityEvent = async () => ({ ok: false, error: { kind: "internal" as const, message: "db error" } });

      const result = await auth.logout(complete.token);
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("internal_error");
    });

    it("propagates request context to session.revoked event", async () => {
      const repo = createFakeRepository();
      const ctx = { requestId: "req_logout1", ip: "10.0.0.1", userAgent: "CLI/2.0" };
      const auth = createAuthService({ repo, now: () => fixedNow, ctx });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      await auth.logout(complete.token);

      const event = repo._securityEvents.find((e) => e.eventType === "session.revoked")!;
      expect(event.requestId).toBe("req_logout1");
      expect(event.ip).toBe("10.0.0.1");
      expect(event.userAgent).toBe("CLI/2.0");
    });
  });
});

describe("UUID/public-ID mapping", () => {
  it("parseSessionToken extracts UUID from token", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const token = buildSessionToken(uuid, "secrethex");
    const result = parseSessionToken(token);
    expect(result).toEqual({ sessionId: uuid, secret: "secrethex" });
  });

  it("parseSessionToken returns null for invalid hex length", () => {
    expect(parseSessionToken("sps_ses_tooshort.secret")).toBeNull();
  });

  it("parseSessionToken returns null for missing prefix", () => {
    expect(parseSessionToken("ses_abc.secret")).toBeNull();
  });

  it("parseSessionToken returns null for missing dot", () => {
    expect(parseSessionToken("sps_ses_00000000000000000000000000000000")).toBeNull();
  });

  it("parseChallengePublicId converts to UUID", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const publicId = challengePublicId(uuid);
    expect(publicId).toBe("chl_550e8400e29b41d4a716446655440000");
    expect(parseChallengePublicId(publicId)).toBe(uuid);
  });

  it("parseChallengePublicId returns null for wrong prefix", () => {
    expect(parseChallengePublicId("usr_550e8400e29b41d4a716446655440000")).toBeNull();
  });

  it("parseChallengePublicId returns null for invalid hex", () => {
    expect(parseChallengePublicId("chl_notvalidhex")).toBeNull();
  });
});

describe("buildSessionToken", () => {
  it("builds correct format from UUID", () => {
    const token = buildSessionToken("550e8400-e29b-41d4-a716-446655440000", "mysecret");
    expect(token).toBe("sps_ses_550e8400e29b41d4a716446655440000.mysecret");
  });
});
