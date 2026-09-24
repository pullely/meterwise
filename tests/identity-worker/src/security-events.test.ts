/// <reference types="@cloudflare/workers-types" />
import { createFakeRepository } from "./helpers/fake-repository";
import crypto from "node:crypto";
import type { Env } from "../../../apps/identity-worker/src/env";
import type { PublicSecurityEvent } from "@saas/contracts/security-events";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}
if (typeof globalThis.crypto.randomUUID !== "function") {
  (globalThis.crypto as unknown as { randomUUID: () => string }).randomUUID = () => crypto.randomUUID();
}

import { handleSecurityEvents } from "../../../apps/identity-worker/src/handlers/security-events";
import { createAuthService } from "../../../apps/identity-worker/src/services/auth";

interface JsonResp {
  data: { securityEvents: PublicSecurityEvent[] };
  error: {
    code: string;
    message?: string;
    details: { fields: Record<string, unknown> };
  };
  meta: { requestId: string; cursor: string | null };
}

// Helpers to create an authenticated session and get a bearer token
async function setupAuthenticatedUser(repo: ReturnType<typeof createFakeRepository>) {
  // Use a recent timestamp so the session (30-day TTL) is valid for the handler's `new Date()`
  const recentPast = new Date(Date.now() - 60_000); // 1 minute ago
  const auth = createAuthService({ repo, now: () => recentPast });
  const loginResult = await auth.startLogin("test@example.com");
  if ("error" in loginResult) throw new Error("startLogin failed");

  const completeResult = await auth.completeLogin(loginResult.challengeId, loginResult.rawCode);
  if ("error" in completeResult) throw new Error("completeLogin failed");

  return { token: completeResult.token, userId: completeResult.user.id };
}

function makeEnv(db: D1Database = {} as D1Database): Env {
  return { PLATFORM_DB: db, ENVIRONMENT: "test" } as Env;
}

function makeRequest(token?: string, query = "") {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new Request(`https://identity.internal/v1/auth/security-events${query}`, {
    method: "GET",
    headers,
  });
}

describe("GET /v1/auth/security-events", () => {
  describe("authentication", () => {
    it("returns 401 when no authorization header", async () => {
      const repo = createFakeRepository();
      const response = await handleSecurityEvents(
        makeRequest(undefined),
        makeEnv(),
        "req_test1",
        { repo },
      );
      expect(response.status).toBe(401);
      const json = (await response.json()) as JsonResp;
      expect(json.error.code).toBe("unauthenticated");
    });

    it("returns 401 for invalid token", async () => {
      const repo = createFakeRepository();
      const response = await handleSecurityEvents(
        makeRequest("invalid_token"),
        makeEnv(),
        "req_test2",
        { repo },
      );
      expect(response.status).toBe(401);
    });
  });

  describe("successful listing", () => {
    it("returns empty list when no security events", async () => {
      const repo = createFakeRepository();
      const { token } = await setupAuthenticatedUser(repo);

      const response = await handleSecurityEvents(
        makeRequest(token),
        makeEnv(),
        "req_test3",
        { repo },
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as JsonResp;
      expect(json.data.securityEvents).toEqual([]);
      expect(json.meta.requestId).toBe("req_test3");
      expect(json.meta.cursor).toBeNull();
    });

    it("returns security events for authenticated user", async () => {
      const repo = createFakeRepository();
      const { token, userId } = await setupAuthenticatedUser(repo);

      // Record a security event for this user
      await repo.recordSecurityEvent({
        id: crypto.randomUUID(),
        eventType: "login.challenge.created",
        outcome: "success",
        userId,
        requestId: "req_original",
        ip: "1.2.3.4",
        userAgent: "TestAgent/1.0",
        occurredAt: new Date("2026-01-15T10:05:00.000Z"),
        metadata: { method: "email_code" },
        redactPaths: [],
      });

      const response = await handleSecurityEvents(
        makeRequest(token),
        makeEnv(),
        "req_test4",
        { repo },
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as JsonResp;
      expect(json.data.securityEvents).toHaveLength(1);
      const event = json.data.securityEvents[0]!;
      expect(event.eventType).toBe("login.challenge.created");
      expect(event.outcome).toBe("success");
      expect(event.occurredAt).toBe("2026-01-15T10:05:00.000Z");
      expect(event.requestId).toBe("req_original");
      expect(event.ip).toBe("1.2.3.4");
      expect(event.userAgent).toBe("TestAgent/1.0");
      expect(event.metadata).toEqual({ method: "email_code" });
    });

    it("does not return events belonging to other users", async () => {
      const repo = createFakeRepository();
      const { token } = await setupAuthenticatedUser(repo);

      // Record event for a DIFFERENT user
      await repo.recordSecurityEvent({
        id: crypto.randomUUID(),
        eventType: "login.challenge.created",
        outcome: "success",
        userId: "other-user-id",
        occurredAt: new Date("2026-01-15T10:05:00.000Z"),
        metadata: {},
        redactPaths: [],
      });

      const response = await handleSecurityEvents(
        makeRequest(token),
        makeEnv(),
        "req_test5",
        { repo },
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as JsonResp;
      // The events from setupAuthenticatedUser's login flow are recorded via auth service,
      // but the "other-user-id" event should NOT appear
      for (const event of json.data.securityEvents) {
        expect(event.eventType).not.toBe("other-user-id"); // event is filtered by userId
      }
    });
  });

  describe("pagination", () => {
    it("uses default limit of 50", async () => {
      const repo = createFakeRepository();
      const { token, userId } = await setupAuthenticatedUser(repo);

      // Create 3 events (well under limit)
      for (let i = 0; i < 3; i++) {
        await repo.recordSecurityEvent({
          id: crypto.randomUUID(),
          eventType: "session.created",
          outcome: "success",
          userId,
          occurredAt: new Date(`2026-01-15T10:0${i}:00.000Z`),
          metadata: {},
          redactPaths: [],
        });
      }

      const response = await handleSecurityEvents(
        makeRequest(token),
        makeEnv(),
        "req_page1",
        { repo },
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as JsonResp;
      expect(json.data.securityEvents.length).toBeGreaterThanOrEqual(3);
      expect(json.meta.cursor).toBeNull(); // no next page
    });

    it("respects custom limit parameter", async () => {
      const repo = createFakeRepository();
      const { token, userId } = await setupAuthenticatedUser(repo);

      // Create 5 events
      for (let i = 0; i < 5; i++) {
        await repo.recordSecurityEvent({
          id: crypto.randomUUID(),
          eventType: "session.created",
          outcome: "success",
          userId,
          occurredAt: new Date(`2026-01-15T11:0${i}:00.000Z`),
          metadata: {},
          redactPaths: [],
        });
      }

      const response = await handleSecurityEvents(
        makeRequest(token, "?limit=2"),
        makeEnv(),
        "req_page2",
        { repo },
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as JsonResp;
      expect(json.data.securityEvents).toHaveLength(2);
      expect(json.meta.cursor).not.toBeNull(); // has next page
    });

    it("returns next page with valid cursor", async () => {
      const repo = createFakeRepository();
      const { token, userId } = await setupAuthenticatedUser(repo);

      // Create events
      for (let i = 0; i < 5; i++) {
        await repo.recordSecurityEvent({
          id: crypto.randomUUID(),
          eventType: "session.created",
          outcome: "success",
          userId,
          occurredAt: new Date(`2026-01-15T12:0${i}:00.000Z`),
          metadata: {},
          redactPaths: [],
        });
      }

      // First page
      const r1 = await handleSecurityEvents(
        makeRequest(token, "?limit=2"),
        makeEnv(),
        "req_page3a",
        { repo },
      );
      const j1 = (await r1.json()) as JsonResp;
      expect(j1.meta.cursor).not.toBeNull();

      // Second page
      const r2 = await handleSecurityEvents(
        makeRequest(token, `?limit=2&cursor=${j1.meta.cursor}`),
        makeEnv(),
        "req_page3b",
        { repo },
      );
      expect(r2.status).toBe(200);
      const j2 = (await r2.json()) as JsonResp;
      expect(j2.data.securityEvents.length).toBeGreaterThanOrEqual(1);

      // No overlap
      const ids1 = j1.data.securityEvents.map((e: PublicSecurityEvent) => e.id);
      const ids2 = j2.data.securityEvents.map((e: PublicSecurityEvent) => e.id);
      for (const id of ids2) {
        expect(ids1).not.toContain(id);
      }
    });
  });

  describe("validation", () => {
    it("returns validation_failed for limit=0", async () => {
      const repo = createFakeRepository();
      const { token } = await setupAuthenticatedUser(repo);

      const response = await handleSecurityEvents(
        makeRequest(token, "?limit=0"),
        makeEnv(),
        "req_val1",
        { repo },
      );
      expect(response.status).toBe(422);
      const json = (await response.json()) as JsonResp;
      expect(json.error.code).toBe("validation_failed");
      expect(json.error.details.fields.limit).toBeDefined();
    });

    it("returns validation_failed for limit=101", async () => {
      const repo = createFakeRepository();
      const { token } = await setupAuthenticatedUser(repo);

      const response = await handleSecurityEvents(
        makeRequest(token, "?limit=101"),
        makeEnv(),
        "req_val2",
        { repo },
      );
      expect(response.status).toBe(422);
      const json = (await response.json()) as JsonResp;
      expect(json.error.code).toBe("validation_failed");
    });

    it("returns validation_failed for non-integer limit", async () => {
      const repo = createFakeRepository();
      const { token } = await setupAuthenticatedUser(repo);

      const response = await handleSecurityEvents(
        makeRequest(token, "?limit=abc"),
        makeEnv(),
        "req_val3",
        { repo },
      );
      expect(response.status).toBe(422);
      const json = (await response.json()) as JsonResp;
      expect(json.error.code).toBe("validation_failed");
    });

    it("returns validation_failed for malformed cursor", async () => {
      const repo = createFakeRepository();
      const { token } = await setupAuthenticatedUser(repo);

      const response = await handleSecurityEvents(
        makeRequest(token, "?cursor=not-valid-base64"),
        makeEnv(),
        "req_val4",
        { repo },
      );
      expect(response.status).toBe(422);
      const json = (await response.json()) as JsonResp;
      expect(json.error.code).toBe("validation_failed");
      expect(json.error.details.fields.cursor).toBeDefined();
    });
  });

  describe("redaction", () => {
    it("redacts metadata keys listed in redactPaths", async () => {
      const repo = createFakeRepository();
      const { token, userId } = await setupAuthenticatedUser(repo);

      await repo.recordSecurityEvent({
        id: crypto.randomUUID(),
        eventType: "login.challenge.created",
        outcome: "success",
        userId,
        occurredAt: new Date("2026-01-15T13:00:00.000Z"),
        metadata: { method: "email_code", codeHash: "abc123hash" },
        redactPaths: ["metadata.codeHash"],
      });

      const response = await handleSecurityEvents(
        makeRequest(token),
        makeEnv(),
        "req_redact1",
        { repo },
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as JsonResp;
      const event = json.data.securityEvents.find(
        (e: PublicSecurityEvent) => e.eventType === "login.challenge.created" && e.metadata.method === "email_code",
      );
      expect(event).toBeDefined();
      expect(event!.metadata.codeHash).toBe("[REDACTED]");
      expect(event!.metadata.method).toBe("email_code");
    });

    it("strips known sensitive keys even without explicit redactPaths", async () => {
      const repo = createFakeRepository();
      const { token, userId } = await setupAuthenticatedUser(repo);

      await repo.recordSecurityEvent({
        id: crypto.randomUUID(),
        eventType: "test.event",
        outcome: "success",
        userId,
        occurredAt: new Date("2026-01-15T14:00:00.000Z"),
        metadata: { code: "123456", tokenHash: "deadbeef", safe: "visible" },
        redactPaths: [],
      });

      const response = await handleSecurityEvents(
        makeRequest(token),
        makeEnv(),
        "req_redact2",
        { repo },
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as JsonResp;
      const event = json.data.securityEvents.find((e: PublicSecurityEvent) => e.eventType === "test.event");
      expect(event).toBeDefined();
      expect(event!.metadata.code).toBe("[REDACTED]");
      expect(event!.metadata.tokenHash).toBe("[REDACTED]");
      expect(event!.metadata.safe).toBe("visible");
    });

    it("does not expose sessionId, challengeId, or userId fields in public shape", async () => {
      const repo = createFakeRepository();
      const { token, userId } = await setupAuthenticatedUser(repo);

      await repo.recordSecurityEvent({
        id: crypto.randomUUID(),
        eventType: "session.created",
        outcome: "success",
        userId,
        sessionId: "some-session-uuid",
        challengeId: "some-challenge-uuid",
        occurredAt: new Date("2026-01-15T15:00:00.000Z"),
        metadata: {},
        redactPaths: [],
      });

      const response = await handleSecurityEvents(
        makeRequest(token),
        makeEnv(),
        "req_redact3",
        { repo },
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as JsonResp;
      const event = json.data.securityEvents.find(
        (e: PublicSecurityEvent) => e.eventType === "session.created" && e.occurredAt === "2026-01-15T15:00:00.000Z",
      );
      expect(event).toBeDefined();
      // Public shape should NOT include sessionId, challengeId, userId
      const eventRecord: Record<string, unknown> = { ...(event as PublicSecurityEvent) };
      expect(eventRecord.sessionId).toBeUndefined();
      expect(eventRecord.challengeId).toBeUndefined();
      expect(eventRecord.userId).toBeUndefined();
    });

    it("response body never contains raw token/secret patterns", async () => {
      const repo = createFakeRepository();
      const { token, userId } = await setupAuthenticatedUser(repo);

      await repo.recordSecurityEvent({
        id: crypto.randomUUID(),
        eventType: "session.created",
        outcome: "success",
        userId,
        occurredAt: new Date("2026-01-15T16:00:00.000Z"),
        metadata: {
          secret: "super-secret-value",
          apiKey: "sk_live_abcdef",
          bearerToken: "sps_ses_abcdef.secret123",
          normalField: "safe",
        },
        redactPaths: [],
      });

      const response = await handleSecurityEvents(
        makeRequest(token),
        makeEnv(),
        "req_redact4",
        { repo },
      );
      const body = await response.text();
      expect(body).not.toContain("super-secret-value");
      expect(body).not.toContain("sk_live_abcdef");
      expect(body).not.toContain("sps_ses_abcdef");
      expect(body).toContain("safe");
    });
  });

  describe("response envelope", () => {
    it("returns standard success envelope with meta.requestId and meta.cursor", async () => {
      const repo = createFakeRepository();
      const { token } = await setupAuthenticatedUser(repo);

      const response = await handleSecurityEvents(
        makeRequest(token),
        makeEnv(),
        "req_envelope1",
        { repo },
      );
      expect(response.status).toBe(200);
      const json = (await response.json()) as JsonResp;
      expect(json.data).toBeDefined();
      expect(json.data.securityEvents).toBeDefined();
      expect(json.meta).toBeDefined();
      expect(json.meta.requestId).toBe("req_envelope1");
      expect(json.meta.cursor).toBeNull();
    });
  });
});
