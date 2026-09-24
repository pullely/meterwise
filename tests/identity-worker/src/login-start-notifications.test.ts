/// <reference types="@cloudflare/workers-types" />
/**
 * Task 0090: idempotency-key population for the magic-link login-start
 * notification enqueue.
 *
 * Verifies that `handleLoginStart` populates a deterministic, template-scoped
 * `idempotencyKey` derived from the durable `challengeId` public id — and that
 * the key never contains the raw 6-digit code or its server-side hash.
 */
import { createFakeRepository } from "./helpers/fake-repository";
import crypto from "node:crypto";
import type { Env } from "../../../apps/identity-worker/src/env";
import type { LoginStartResponse } from "@saas/contracts/auth";
import type {
  NotificationsClientContext,
  NotificationsEnvBinding,
  EnqueueNotificationResult,
} from "@saas/notifications-client";
import type { EnqueueNotificationRequest } from "@saas/contracts/notifications";

interface GlobalCryptoLike {
  crypto?: { subtle?: unknown; randomUUID?: () => string };
}
const g: GlobalCryptoLike = globalThis;
if (!g.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}
if (typeof g.crypto?.randomUUID !== "function") {
  (g.crypto as { randomUUID: () => string }).randomUUID = () => crypto.randomUUID();
}

import { handleLoginStart } from "../../../apps/identity-worker/src/handlers/login-start";

type EnqueueArgs = {
  env: NotificationsEnvBinding;
  ctx: NotificationsClientContext;
  request: EnqueueNotificationRequest;
};

function makeRecorder() {
  const calls: EnqueueArgs[] = [];
  const fn = async (
    env: NotificationsEnvBinding,
    ctx: NotificationsClientContext,
    request: EnqueueNotificationRequest,
  ): Promise<EnqueueNotificationResult> => {
    calls.push({ env, ctx, request });
    return { ok: true as const, notificationId: `notif_${calls.length}` };
  };
  return { calls, fn };
}

function makeEnv(extras: Partial<Env> = {}): Env {
  return {
    PLATFORM_DB: {} as D1Database,
    ENVIRONMENT: "test",
    NOTIFICATIONS_WORKER: {} as Fetcher,
    ...extras,
  } as Env;
}

function makeRequest(email: string) {
  return new Request("https://identity.internal/v1/auth/login/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

describe("handleLoginStart — idempotencyKey (Task 0090)", () => {
  it("populates a deterministic, template-scoped idempotencyKey derived from challengeId", async () => {
    const repo = createFakeRepository();
    const recorder = makeRecorder();

    const response = await handleLoginStart(
      makeRequest("alice@example.com"),
      makeEnv(),
      "req_login_1",
      { repo, enqueueNotification: recorder.fn },
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: LoginStartResponse };
    const challengeId: string = json.data.challengeId;
    expect(challengeId).toMatch(/^chl_[0-9a-f]+$/);

    expect(recorder.calls).toHaveLength(1);
    const { request } = recorder.calls[0]!;

    expect(request.idempotencyKey).toBeDefined();
    expect(request.idempotencyKey).toBe(`auth.magic_link:${challengeId}`);
    expect(request.idempotencyKey).toMatch(/^auth\.magic_link:chl_[0-9a-f]+$/);
    expect(request.templateKey).toBe("auth.magic_link");
    expect(request.category).toBe("security");
  });

  it("never leaks the raw 6-digit code or its hash into idempotencyKey", async () => {
    const repo = createFakeRepository();
    const recorder = makeRecorder();

    await handleLoginStart(
      makeRequest("bob@example.com"),
      makeEnv(),
      "req_login_2",
      { repo, enqueueNotification: recorder.fn },
    );

    const { request } = recorder.calls[0]!;
    const rawCode = request.templateData!.code as string;
    expect(rawCode).toMatch(/^\d{6}$/);

    // The key MUST NOT contain the raw code itself.
    expect(request.idempotencyKey).not.toContain(rawCode);
    // No long hex run that could be a SHA-256 hash leak (64 hex chars).
    // (We can't assert "no 6-digit run" — challengeId is hex and may
    // legitimately contain 6 consecutive decimal-only digits by chance.)
    expect(request.idempotencyKey ?? "").not.toMatch(/[0-9a-f]{64}/);
  });

  it("yields different keys for two distinct login attempts (different challenges)", async () => {
    const repo = createFakeRepository();
    const recorder = makeRecorder();

    const r1 = await handleLoginStart(
      makeRequest("carol@example.com"),
      makeEnv(),
      "req_login_3a",
      { repo, enqueueNotification: recorder.fn },
    );
    const r2 = await handleLoginStart(
      makeRequest("carol@example.com"),
      makeEnv(),
      "req_login_3b",
      { repo, enqueueNotification: recorder.fn },
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    expect(recorder.calls).toHaveLength(2);
    const k1 = recorder.calls[0]!.request.idempotencyKey;
    const k2 = recorder.calls[1]!.request.idempotencyKey;
    expect(k1).toBeDefined();
    expect(k2).toBeDefined();
    // Different challenges = different keys; the worker dedup is intentionally
    // per-logical-attempt, not per-email.
    expect(k1).not.toBe(k2);
  });

  it("skips enqueue entirely in DEBUG_DELIVERY mode (no idempotencyKey path)", async () => {
    const repo = createFakeRepository();
    const recorder = makeRecorder();

    const response = await handleLoginStart(
      makeRequest("dave@example.com"),
      makeEnv({ DEBUG_DELIVERY: "true" }),
      "req_login_4",
      { repo, enqueueNotification: recorder.fn },
    );
    expect(response.status).toBe(200);
    expect(recorder.calls).toHaveLength(0);
  });
});
