/// <reference types="@cloudflare/workers-types" />
/**
 * Canonical test suite for `@saas/notifications-client`. This used to live
 * twice — once under `tests/identity-worker/` and once under
 * `tests/membership-worker/` — when each worker carried its own copy of
 * the client. With the Task 0089 extraction it's a single package, so the
 * suite lives once, here, and is executed under `@saas/notifications-client-tests`.
 */
import {
  enqueueNotification,
  buildIdempotencyKey,
  type NotificationsEnvBinding,
} from "@saas/notifications-client";

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

function makeEnv(handler?: FetchHandler): NotificationsEnvBinding {
  if (!handler) return {};
  return {
    NOTIFICATIONS_WORKER: {
      fetch: handler,
    } as unknown as NonNullable<NotificationsEnvBinding["NOTIFICATIONS_WORKER"]>,
  };
}

const baseCtx = {
  internalActor: "identity-worker",
  actorSubjectType: "system",
  actorSubjectId: "identity-worker",
  requestId: "req_test_123",
};

const baseRequest = {
  orgId: "00000000-0000-0000-0000-000000000000",
  category: "security" as const,
  templateKey: "auth.magic_link",
  templateData: {
    code: "123456",
    emailHint: "t***@example.com",
    expiresAt: "2026-05-30T10:00:00.000Z",
    requestId: "req_test_123",
  },
  recipient: {
    channel: "email" as const,
    address: "test@example.com",
  },
};

describe("@saas/notifications-client enqueueNotification", () => {
  it("returns no_binding when NOTIFICATIONS_WORKER is missing", async () => {
    const result = await enqueueNotification(makeEnv(), baseCtx, baseRequest);
    expect(result).toEqual({ ok: false, reason: "no_binding" });
  });

  it("posts to the internal enqueue URL with the required headers", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const handler: FetchHandler = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          data: {
            notification: {
              id: "ntf_abc123",
              orgId: baseRequest.orgId,
              category: "security",
              templateKey: "auth.magic_link",
              status: "sent",
              recipient: { channel: "email", address: baseRequest.recipient.address },
              providerMessageId: "local-debug-xyz",
              queuedAt: "2026-05-30T10:00:00.000Z",
              sentAt: "2026-05-30T10:00:00.000Z",
              failedAt: null,
              lastError: null,
              attempts: [],
            },
          },
          meta: { requestId: baseCtx.requestId, cursor: null },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };

    const result = await enqueueNotification(makeEnv(handler), baseCtx, baseRequest);

    expect(result).toEqual({ ok: true, notificationId: "ntf_abc123" });
    expect(capturedUrl).toBe("https://notifications.internal/v1/notifications");
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["x-internal-actor"]).toBe("identity-worker");
    expect(headers["x-actor-subject-type"]).toBe("system");
    expect(headers["x-actor-subject-id"]).toBe("identity-worker");
    expect(headers["x-request-id"]).toBe(baseCtx.requestId);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(capturedInit?.body as string);
    expect(body.category).toBe("security");
    expect(body.templateKey).toBe("auth.magic_link");
    expect(body.recipient.channel).toBe("email");
    expect(body.recipient.address).toBe(baseRequest.recipient.address);
  });

  it("forwards membership-worker caller identity headers correctly", async () => {
    let capturedInit: RequestInit | undefined;
    const handler: FetchHandler = async (_url, init) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({ data: { notification: { id: "ntf_xyz" } } }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    };

    const ctx = {
      internalActor: "membership-worker",
      actorSubjectType: "user",
      actorSubjectId: "usr_admin",
      requestId: "req_mem_1",
    };
    const req = {
      orgId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      category: "invitation" as const,
      templateKey: "invitation.created",
      templateData: { role: "builder" },
      recipient: { channel: "email" as const, address: "i@example.com" },
    };

    const result = await enqueueNotification(makeEnv(handler), ctx, req);
    expect(result).toEqual({ ok: true, notificationId: "ntf_xyz" });
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["x-internal-actor"]).toBe("membership-worker");
    expect(headers["x-actor-subject-type"]).toBe("user");
    expect(headers["x-actor-subject-id"]).toBe("usr_admin");
  });

  it("returns non_2xx when the worker responds with a 4xx/5xx", async () => {
    const handler: FetchHandler = async () =>
      new Response(JSON.stringify({ error: { code: "validation_failed" } }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });

    const result = await enqueueNotification(makeEnv(handler), baseCtx, baseRequest);
    expect(result).toEqual({ ok: false, reason: "non_2xx" });
  });

  it("returns network_error when the binding fetch throws", async () => {
    const handler: FetchHandler = async () => {
      throw new TypeError("network down");
    };

    const result = await enqueueNotification(makeEnv(handler), baseCtx, baseRequest);
    expect(result).toEqual({ ok: false, reason: "network_error" });
  });

  it("returns bad_response when the body is not the expected envelope", async () => {
    const handler: FetchHandler = async () =>
      new Response(JSON.stringify({ unexpected: true }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });

    const result = await enqueueNotification(makeEnv(handler), baseCtx, baseRequest);
    expect(result).toEqual({ ok: false, reason: "bad_response" });
  });

  it("returns bad_response when the body is malformed JSON", async () => {
    const handler: FetchHandler = async () =>
      new Response("not json at all", {
        status: 201,
        headers: { "content-type": "application/json" },
      });

    const result = await enqueueNotification(makeEnv(handler), baseCtx, baseRequest);
    expect(result).toEqual({ ok: false, reason: "bad_response" });
  });

  it("never throws — all failure modes return a result", async () => {
    const handler: FetchHandler = async () => {
      throw new Error("boom");
    };

    await expect(
      enqueueNotification(makeEnv(handler), baseCtx, baseRequest),
    ).resolves.toBeDefined();
  });
});

describe("buildIdempotencyKey", () => {
  it("returns a deterministic, scope-prefixed string", () => {
    expect(buildIdempotencyKey("auth.magic_link", "chl_abc")).toBe(
      "auth.magic_link:chl_abc",
    );
    expect(
      buildIdempotencyKey("invitation.accepted", "inv_xyz", "mem_qux"),
    ).toBe("invitation.accepted:inv_xyz:mem_qux");
  });

  it("is pure — same inputs produce the same output across calls", () => {
    const a = buildIdempotencyKey("invitation.created", "inv_1");
    const b = buildIdempotencyKey("invitation.created", "inv_1");
    expect(a).toBe(b);
  });

  it("template-scopes — different scopes with the same id never collide", () => {
    const created = buildIdempotencyKey("invitation.created", "inv_1");
    const accepted = buildIdempotencyKey("invitation.accepted", "inv_1");
    expect(created).not.toBe(accepted);
  });

  it("rejects empty scope", () => {
    expect(() => buildIdempotencyKey("", "inv_1")).toThrow(TypeError);
  });

  it("rejects calls with no parts", () => {
    expect(() => (buildIdempotencyKey as (s: string) => string)("auth.magic_link")).toThrow(TypeError);
  });

  it("rejects empty parts", () => {
    expect(() => buildIdempotencyKey("invitation.created", "")).toThrow(TypeError);
  });

  it("rejects parts containing whitespace, ':' or control characters", () => {
    expect(() => buildIdempotencyKey("auth.magic_link", "has space")).toThrow(TypeError);
    expect(() => buildIdempotencyKey("auth.magic_link", "has:colon")).toThrow(TypeError);
    expect(() => buildIdempotencyKey("auth.magic_link", "has\nnewline")).toThrow(TypeError);
    expect(() => buildIdempotencyKey("auth.magic_link", "has\u0007bell")).toThrow(TypeError);
  });
});
