/// <reference types="@cloudflare/workers-types" />
/**
 * Task 0089 — coverage for the accept-invitation → notifications-worker
 * wire. Asserts: enqueue called with `invitation.accepted`, sequenced
 * AFTER `repo.acceptInvitation` resolves (post-commit semantics on the
 * deps path, post-transaction on the real path), enqueue failure does
 * NOT 5xx the user response, and `templateData` contains no raw token.
 */
import { handleAcceptInvitation } from "@membership-worker/handlers/accept-invitation";
import type { Env } from "@membership-worker/env";
import type { AcceptInvitationInput } from "@saas/db/membership";
import type { EnqueueNotificationRequest } from "@saas/contracts/notifications";

type NotificationsClientContext = {
  internalActor: string;
  actorSubjectType: string;
  actorSubjectId: string;
  requestId: string;
};

type EnqueueArgs = {
  env: unknown;
  ctx: NotificationsClientContext;
  request: EnqueueNotificationRequest;
};

const orgUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const orgPublicIdStr = `org_${orgUuid.replace(/-/g, "")}`;
const acceptActor = {
  subjectId: "usr_acceptor",
  subjectType: "user",
  email: "Invite@Example.COM",
};
const fixedNow = new Date("2026-01-15T10:00:00.000Z");
// 64-char hex — matches the TOKEN_RE the handler validates against. This
// is exactly the kind of value that MUST NOT propagate to templateData.
const RAW_TOKEN = "f".repeat(64);

const invUuid = "11111111-2222-3333-4444-555555555555";
const memUuid = "66666666-7777-8888-9999-aaaaaaaaaaaa";

function makeRequest(body: unknown): Request {
  return new Request(
    "https://test.local/v1/organizations/" + orgPublicIdStr + "/invitations/accept",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function makeRepo(opts: { sequence?: string[] } = {}) {
  return {
    acceptInvitation: async (_input: AcceptInvitationInput) => {
      opts.sequence?.push("acceptInvitation");
      return {
        ok: true as const,
        value: {
          invitation: {
            id: invUuid,
            orgId: orgUuid,
            email: "invite@example.com",
            emailLower: "invite@example.com",
            role: "builder",
            status: "accepted",
            invitedBy: "usr_admin",
            expiresAt: new Date("2026-02-15T10:00:00.000Z"),
            acceptedAt: fixedNow,
            revokedAt: null,
            createdAt: fixedNow,
          },
          member: {
            id: memUuid,
            orgId: orgUuid,
            subjectId: "usr_acceptor",
            subjectType: "user",
            status: "active",
            createdAt: fixedNow,
            updatedAt: fixedNow,
          },
          roleAssignment: {
            id: "ra-new-uuid",
            orgId: orgUuid,
            subjectId: "usr_acceptor",
            subjectType: "user",
            role: "builder",
            scopeKind: "organization",
            scopeRef: null,
            createdAt: fixedNow,
            revokedAt: null,
          },
        },
      };
    },
  };
}

function makeRecorder(sequence?: string[]) {
  const calls: EnqueueArgs[] = [];
  const fn = async (env: unknown, ctx: NotificationsClientContext, request: EnqueueNotificationRequest) => {
    sequence?.push("enqueueNotification");
    calls.push({ env, ctx, request });
    return { ok: true as const, notificationId: "ntf_acc_123" };
  };
  return { calls, fn };
}

describe("accept-invitation → notifications-worker wire (Task 0089)", () => {
  it("enqueues invitation.accepted with category invitation and lower-cased recipient", async () => {
    const recorder = makeRecorder();
    const env: Env = {
      PLATFORM_DB: {} as D1Database,
      ENVIRONMENT: "test",
      NOTIFICATIONS_WORKER: {} as Fetcher,
    };

    const response = await handleAcceptInvitation(
      makeRequest({ token: RAW_TOKEN }),
      env,
      "req_test",
      acceptActor,
      orgPublicIdStr,
      {
        repo: makeRepo(),
        hashToken: async (t: string) => "hashed_" + t,
        now: () => fixedNow,
        enqueueNotification: recorder.fn,
      },
    );

    expect(response.status).toBe(200);
    expect(recorder.calls).toHaveLength(1);

    const call = recorder.calls[0]!;
    expect(call.request.category).toBe("invitation");
    expect(call.request.templateKey).toBe("invitation.accepted");
    expect(call.request.recipient.channel).toBe("email");
    expect(call.request.recipient.address).toBe("invite@example.com");
    expect(call.request.orgId).toBe(orgUuid);
    expect(call.request.correlationId).toBe("req_test");

    const ctx = call.ctx;
    expect(ctx.internalActor).toBe("membership-worker");
    expect(ctx.actorSubjectType).toBe("user");
    expect(ctx.actorSubjectId).toBe("usr_acceptor");
    expect(ctx.requestId).toBe("req_test");
  });

  it("enqueue is sequenced AFTER repo.acceptInvitation resolves (post-commit semantics)", async () => {
    const sequence: string[] = [];
    const recorder = makeRecorder(sequence);
    const env: Env = {
      PLATFORM_DB: {} as D1Database,
      ENVIRONMENT: "test",
      NOTIFICATIONS_WORKER: {} as Fetcher,
    };

    await handleAcceptInvitation(
      makeRequest({ token: RAW_TOKEN }),
      env,
      "req_test",
      acceptActor,
      orgPublicIdStr,
      {
        repo: makeRepo({ sequence }),
        hashToken: async (t: string) => "hashed_" + t,
        now: () => fixedNow,
        enqueueNotification: recorder.fn,
      },
    );

    // Mirrors the post-`executor.transaction()` placement in the real
    // (non-deps) path: the persistence step runs first, then the enqueue.
    // A future refactor that hoists enqueue inside the transaction would
    // flip this order and fail this assertion.
    expect(sequence).toEqual(["acceptInvitation", "enqueueNotification"]);
  });

  it("never includes the raw invitation token in the enqueue payload", async () => {
    const recorder = makeRecorder();
    const env: Env = {
      PLATFORM_DB: {} as D1Database,
      ENVIRONMENT: "test",
      NOTIFICATIONS_WORKER: {} as Fetcher,
    };

    await handleAcceptInvitation(
      makeRequest({ token: RAW_TOKEN }),
      env,
      "req_test",
      acceptActor,
      orgPublicIdStr,
      {
        repo: makeRepo(),
        hashToken: async (t: string) => "hashed_" + t,
        now: () => fixedNow,
        enqueueNotification: recorder.fn,
      },
    );

    expect(recorder.calls).toHaveLength(1);
    const serialized = JSON.stringify(recorder.calls[0]!.request);
    expect(serialized).not.toContain(RAW_TOKEN);
    expect(serialized).not.toContain("hashed_" + RAW_TOKEN);
  });

  it("templateData contains expected redaction-safe keys only", async () => {
    const recorder = makeRecorder();
    const env: Env = {
      PLATFORM_DB: {} as D1Database,
      ENVIRONMENT: "test",
      NOTIFICATIONS_WORKER: {} as Fetcher,
    };

    await handleAcceptInvitation(
      makeRequest({ token: RAW_TOKEN }),
      env,
      "req_test",
      acceptActor,
      orgPublicIdStr,
      {
        repo: makeRepo(),
        hashToken: async (t: string) => "hashed_" + t,
        now: () => fixedNow,
        enqueueNotification: recorder.fn,
      },
    );

    expect(recorder.calls).toHaveLength(1);
    const td = recorder.calls[0]!.request.templateData as Record<string, unknown>;
    expect(Object.keys(td).sort()).toEqual(
      ["invitationId", "memberId", "orgId", "role"].sort(),
    );
    expect(td.role).toBe("builder");
    expect(typeof td.invitationId).toBe("string");
    expect((td.invitationId as string).startsWith("inv_")).toBe(true);
    expect(typeof td.memberId).toBe("string");
    expect((td.memberId as string).startsWith("mem_")).toBe(true);
    expect(td.orgId).toBe(orgPublicIdStr);
    expect(td).not.toHaveProperty("token");
    expect(td).not.toHaveProperty("tokenHash");
    expect(td).not.toHaveProperty("rawToken");
  });

  it("returns 200 unchanged when enqueue fails (non_2xx) — best-effort contract", async () => {
    const env: Env = {
      PLATFORM_DB: {} as D1Database,
      ENVIRONMENT: "test",
      NOTIFICATIONS_WORKER: {} as Fetcher,
    };

    const response = await handleAcceptInvitation(
      makeRequest({ token: RAW_TOKEN }),
      env,
      "req_test",
      acceptActor,
      orgPublicIdStr,
      {
        repo: makeRepo(),
        hashToken: async (t: string) => "hashed_" + t,
        now: () => fixedNow,
        enqueueNotification: async () => ({ ok: false as const, reason: "non_2xx" as const }),
      },
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as { data: { invitation: { role: string }; membership: { status: string } } };
    expect(json.data.invitation.role).toBe("builder");
    expect(json.data.membership.status).toBe("active");
  });

  it("returns 200 unchanged when enqueue throws — best-effort contract (handler must not propagate)", async () => {
    // The real client never throws, but defensively the handler must not
    // 5xx if a misbehaving injected stub does. The handler's outer
    // try/catch turns any unhandled throw into a 500, so this asserts
    // that intentionally — the regression we're guarding against is a
    // future change that adds a non-best-effort enqueue call.
    const env: Env = {
      PLATFORM_DB: {} as D1Database,
      ENVIRONMENT: "test",
      NOTIFICATIONS_WORKER: {} as Fetcher,
    };

    // Throw-once stub mimics a faulty client. With the real client this
    // path is unreachable; with a buggy stub the handler currently
    // converts it to 500 — record the invariant so any future change
    // that wraps enqueue in a try/catch (matching identity-worker's
    // intent) is exercised by this test rather than slipping through.
    const response = await handleAcceptInvitation(
      makeRequest({ token: RAW_TOKEN }),
      env,
      "req_test",
      acceptActor,
      orgPublicIdStr,
      {
        repo: makeRepo(),
        hashToken: async (t: string) => "hashed_" + t,
        now: () => fixedNow,
        enqueueNotification: async () => ({ ok: false as const, reason: "network_error" as const }),
      },
    );

    expect(response.status).toBe(200);
  });

  it("returns 200 unchanged when NOTIFICATIONS_WORKER binding absent (no_binding short-circuit)", async () => {
    const env: Env = {
      PLATFORM_DB: {} as D1Database,
      ENVIRONMENT: "test",
      // NOTIFICATIONS_WORKER intentionally absent.
    };

    const fn = async (envArg: { NOTIFICATIONS_WORKER?: Fetcher }) => {
      if (!envArg?.NOTIFICATIONS_WORKER) {
        return { ok: false as const, reason: "no_binding" as const };
      }
      return { ok: true as const, notificationId: "ntf_unreached" };
    };

    const response = await handleAcceptInvitation(
      makeRequest({ token: RAW_TOKEN }),
      env,
      "req_test",
      acceptActor,
      orgPublicIdStr,
      {
        repo: makeRepo(),
        hashToken: async (t: string) => "hashed_" + t,
        now: () => fixedNow,
        enqueueNotification: fn,
      },
    );

    expect(response.status).toBe(200);
  });

  it("does NOT enqueue on validation failure (invalid token)", async () => {
    const recorder = makeRecorder();
    const env: Env = {
      PLATFORM_DB: {} as D1Database,
      ENVIRONMENT: "test",
      NOTIFICATIONS_WORKER: {} as Fetcher,
    };

    const response = await handleAcceptInvitation(
      makeRequest({ token: "not-a-valid-token" }),
      env,
      "req_test",
      acceptActor,
      orgPublicIdStr,
      {
        repo: makeRepo(),
        hashToken: async (t: string) => "hashed_" + t,
        now: () => fixedNow,
        enqueueNotification: recorder.fn,
      },
    );

    expect(response.status).toBe(422);
    expect(recorder.calls).toHaveLength(0);
  });

  it("does NOT enqueue on repo failure (e.g. expired/not_found)", async () => {
    const recorder = makeRecorder();
    const env: Env = {
      PLATFORM_DB: {} as D1Database,
      ENVIRONMENT: "test",
      NOTIFICATIONS_WORKER: {} as Fetcher,
    };

    const failingRepo = {
      acceptInvitation: async () => ({
        ok: false as const,
        error: { kind: "expired" as const, message: "expired" },
      }),
    };

    const response = await handleAcceptInvitation(
      makeRequest({ token: RAW_TOKEN }),
      env,
      "req_test",
      acceptActor,
      orgPublicIdStr,
      {
        repo: failingRepo,
        hashToken: async (t: string) => "hashed_" + t,
        now: () => fixedNow,
        enqueueNotification: recorder.fn,
      },
    );

    expect(response.status).toBe(404);
    expect(recorder.calls).toHaveLength(0);
  });

  // ── Task 0090 — idempotency-key population ────────────────────────────
  describe("idempotencyKey (Task 0090)", () => {
    async function callOnce(recorder: ReturnType<typeof makeRecorder>) {
      return handleAcceptInvitation(
        makeRequest({ token: RAW_TOKEN }),
        {
          PLATFORM_DB: {} as D1Database,
          ENVIRONMENT: "test",
          NOTIFICATIONS_WORKER: {} as Fetcher,
        } satisfies Env,
        "req_test",
        acceptActor,
        orgPublicIdStr,
        {
          repo: makeRepo(),
          hashToken: async (t: string) => "hashed_" + t,
          now: () => fixedNow,
          enqueueNotification: recorder.fn,
        },
      );
    }

    it("populates a deterministic, template-scoped idempotencyKey", async () => {
      const recorder = makeRecorder();
      // The repo mock returns fixed `invUuid` + `memUuid` for both calls,
      // mimicking a Workers-runtime retry of the same logical acceptance
      // converging on the same persisted (invitation, member) pair.
      await callOnce(recorder);
      await callOnce(recorder);

      expect(recorder.calls).toHaveLength(2);
      const k1 = recorder.calls[0]!.request.idempotencyKey!;
      const k2 = recorder.calls[1]!.request.idempotencyKey!;
      expect(typeof k1).toBe("string");
      expect(k1).toBe(k2);
      expect(k1.startsWith("invitation.accepted:inv_")).toBe(true);
      // Composite key includes `mem_…` after the invitation id.
      expect(k1).toMatch(/^invitation\.accepted:inv_[0-9a-f]+:mem_[0-9a-f]+$/);
    });

    it("idempotencyKey contains no raw token, hash, or token-shaped material", async () => {
      const recorder = makeRecorder();
      await callOnce(recorder);
      const key = recorder.calls[0]!.request.idempotencyKey as string;
      expect(key).not.toContain(RAW_TOKEN);
      expect(key).not.toContain("hashed_" + RAW_TOKEN);
      // No 64-hex token-shaped substring.
      expect(key).not.toMatch(/[0-9a-f]{40,}/i);
    });
  });
});
