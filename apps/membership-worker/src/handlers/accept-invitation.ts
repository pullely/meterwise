import type { Env } from "../env.js";
import type { MembershipRepository } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { createMembershipRepository } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, orgPublicId, invitationPublicId, memberPublicId, hashToken } from "../ids.js";
import {
  enqueueNotification,
  buildIdempotencyKey,
  type EnqueueNotificationResult,
} from "@saas/notifications-client";

export interface AcceptActorContext {
  subjectId: string;
  subjectType: string;
  email: string;
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

export interface AcceptInvitationDeps {
  repo: Pick<MembershipRepository, "acceptInvitation">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  hashToken?: (raw: string) => Promise<string>;
  now?: () => Date;
  generateId?: () => string;
  /**
   * Injectable notifications enqueue for tests. When omitted on the deps
   * (non-transactional) path, NO enqueue is attempted (mirrors the
   * create-invitation pattern). The real transactional path always calls
   * the real `enqueueNotification` against `env.NOTIFICATIONS_WORKER`
   * (best-effort; absent binding is a no-op).
   */
  enqueueNotification?: (
    env: { NOTIFICATIONS_WORKER?: Fetcher },
    ctx: {
      internalActor: string;
      actorSubjectType: string;
      actorSubjectId: string;
      requestId: string;
    },
    request: Parameters<typeof enqueueNotification>[2],
  ) => Promise<EnqueueNotificationResult>;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

export async function handleAcceptInvitation(
  request: Request,
  env: Env,
  requestId: string,
  actor: AcceptActorContext,
  orgIdParam: string,
  deps?: AcceptInvitationDeps,
): Promise<Response> {
  const orgUuid = parseOrgPublicId(orgIdParam);
  if (!orgUuid) {
    return errorResponse("not_found", "Organization not found", 404, requestId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  if (!body || typeof body !== "object") {
    return validationError(requestId, { body: ["Request body must be a JSON object"] });
  }

  const { token } = body as { token?: unknown };

  const fields: Record<string, string[]> = {};
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    fields.token = ["A valid invitation token is required"];
  }
  if (Object.keys(fields).length > 0) {
    return validationError(requestId, fields);
  }

  const validToken = token as string;

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const hashFn = deps?.hashToken ?? hashToken;
  const tokenHash = await hashFn(validToken);

  const now = deps?.now ? deps.now() : new Date();
  const memberId = crypto.randomUUID();
  const roleAssignmentId = crypto.randomUUID();
  const genId = deps?.generateId ?? (() => randomHex(16));

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    if (executor && "transaction" in executor) {
      const txResult = await executor.transaction(async (txExec) => {
        const txRepo = createMembershipRepository(txExec);
        const txEventsRepo = createEventsRepository(txExec);

        const result = await txRepo.acceptInvitation({
          tokenHash,
          orgId: orgUuid,
          emailLower: actor.email.toLowerCase(),
          memberId,
          roleAssignmentId,
          subjectId: actor.subjectId,
          subjectType: actor.subjectType,
          acceptedAt: now,
        });

        if (!result.ok) {
          return { result };
        }

        const { invitation: inv, member } = result.value;

        const eventResult = await txEventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "invite.accepted",
            version: 1,
            source: "membership-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId: orgUuid,
            subjectKind: "invitation",
            subjectId: inv.id,
            requestId,
            payload: { invitationId: invitationPublicId(inv.id), role: inv.role, memberId: memberPublicId(member.id) },
          },
          audit: {
            id: genId(),
            category: "membership",
            description: `Invitation ${invitationPublicId(inv.id)} accepted`,
          },
        });

        if (!eventResult.ok) {
          throw new Error("event_append_failed");
        }

        return { result };
      });

      if (!txResult.result.ok) {
        const err = txResult.result.error;
        switch (err.kind) {
          case "not_found":
          case "expired":
          case "revoked":
          case "already_accepted":
            return errorResponse("not_found", "Invitation not found", 404, requestId);
          case "conflict":
            return errorResponse("conflict", "Membership already exists", 409, requestId);
          default:
            return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
        }
      }

      const { invitation: inv, member, roleAssignment } = txResult.result.value;

      const publicInv = {
        id: invitationPublicId(inv.id),
        email: inv.email,
        role: inv.role,
        status: "accepted" as const,
        invitedBy: inv.invitedBy,
        expiresAt: inv.expiresAt.toISOString(),
        createdAt: inv.createdAt.toISOString(),
        acceptedAt: inv.acceptedAt ? inv.acceptedAt.toISOString() : null,
        revokedAt: inv.revokedAt ? inv.revokedAt.toISOString() : null,
      };

      // Best-effort: enqueue an `invitation.accepted` notification AFTER
      // the transaction has committed successfully. A rolled-back
      // acceptance must never produce a user-facing notification, so the
      // enqueue lives strictly outside the `executor.transaction(...)`
      // callback. The client never throws and handles all failure modes
      // internally; the 200 response below is identical whether the
      // enqueue succeeded or not.
      //
      // No raw token leaves the worker boundary in `templateData`. Only
      // redaction-safe, code-controlled fields are forwarded; the raw
      // token only ever appears on the inbound request and is hashed
      // before any persistence.
      const enqueueFn = deps?.enqueueNotification ?? enqueueNotification;
      await enqueueFn(
        env,
        {
          internalActor: "membership-worker",
          actorSubjectType: actor.subjectType,
          actorSubjectId: actor.subjectId,
          requestId,
        },
        {
          orgId: orgUuid,
          category: "invitation",
          templateKey: "invitation.accepted",
          templateData: {
            invitationId: invitationPublicId(inv.id),
            role: inv.role,
            memberId: memberPublicId(member.id),
            orgId: orgPublicId(orgUuid),
          },
          recipient: {
            channel: "email",
            address: actor.email.toLowerCase(),
          },
          // Stripe-quality idempotency: a retry of this same
          // post-transaction enqueue (same logical acceptance) must
          // collapse to one notification row + one provider attempt.
          // Composite of `invitationPublicId(inv.id)` +
          // `memberPublicId(member.id)`: acceptance is a one-shot
          // transition that creates `member.id` inside the same
          // committed transaction, so both ids are durable and stable
          // for any future retry. Template-scoped to prevent collision
          // with `invitation.created` on the same invitation. No raw
          // token participates in the key — the inbound token is
          // already hashed before any persistence; only the public-id
          // forms travel here.
          idempotencyKey: buildIdempotencyKey(
            "invitation.accepted",
            invitationPublicId(inv.id),
            memberPublicId(member.id),
          ),
          correlationId: requestId,
        },
      );

      return successResponse(
        {
          invitation: publicInv,
          membership: {
            id: memberPublicId(member.id),
            role: roleAssignment.role,
            joinedAt: member.createdAt.toISOString(),
            status: member.status,
          },
        },
        requestId,
        200,
      );
    }

    // Non-transactional path (unit tests with injected deps)
    const repo = deps ? deps.repo : createMembershipRepository(executor!);

    const result = await repo.acceptInvitation({
      tokenHash,
      orgId: orgUuid,
      emailLower: actor.email.toLowerCase(),
      memberId,
      roleAssignmentId,
      subjectId: actor.subjectId,
      subjectType: actor.subjectType,
      acceptedAt: now,
    });

    if (!result.ok) {
      const err = result.error;
      switch (err.kind) {
        case "not_found":
        case "expired":
        case "revoked":
        case "already_accepted":
          return errorResponse("not_found", "Invitation not found", 404, requestId);
        case "conflict":
          return errorResponse("conflict", "Membership already exists", 409, requestId);
        default:
          return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }
    }

    const { invitation: inv, member, roleAssignment } = result.value;

    if (deps?.eventsRepo) {
      const eventResult = await deps.eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: "invite.accepted",
          version: 1,
          source: "membership-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId: orgUuid,
          subjectKind: "invitation",
          subjectId: inv.id,
          requestId,
          payload: { invitationId: invitationPublicId(inv.id), role: inv.role, memberId: memberPublicId(member.id) },
        },
        audit: {
          id: genId(),
          category: "membership",
          description: `Invitation ${invitationPublicId(inv.id)} accepted`,
        },
      });

      if (!eventResult.ok) {
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }
    }

    const publicInv = {
      id: invitationPublicId(inv.id),
      email: inv.email,
      role: inv.role,
      status: "accepted" as const,
      invitedBy: inv.invitedBy,
      expiresAt: inv.expiresAt.toISOString(),
      createdAt: inv.createdAt.toISOString(),
      acceptedAt: inv.acceptedAt ? inv.acceptedAt.toISOString() : null,
      revokedAt: inv.revokedAt ? inv.revokedAt.toISOString() : null,
    };

    // Deps (non-transactional) path: only enqueue when the caller has
    // explicitly injected a notifications client. The default deps path
    // (older unit tests that predate notifications) MUST NOT attempt an
    // enqueue. Mirrors the create-invitation pattern.
    if (deps?.enqueueNotification) {
      await deps.enqueueNotification(
        env,
        {
          internalActor: "membership-worker",
          actorSubjectType: actor.subjectType,
          actorSubjectId: actor.subjectId,
          requestId,
        },
        {
          orgId: orgUuid,
          category: "invitation",
          templateKey: "invitation.accepted",
          templateData: {
            invitationId: invitationPublicId(inv.id),
            role: inv.role,
            memberId: memberPublicId(member.id),
            orgId: orgPublicId(orgUuid),
          },
          recipient: {
            channel: "email",
            address: actor.email.toLowerCase(),
          },
          // Same idempotency contract as the transactional path; see
          // the comment block above for the full rationale.
          idempotencyKey: buildIdempotencyKey(
            "invitation.accepted",
            invitationPublicId(inv.id),
            memberPublicId(member.id),
          ),
          correlationId: requestId,
        },
      );
    }

    return successResponse(
      {
        invitation: publicInv,
        membership: {
          id: memberPublicId(member.id),
          role: roleAssignment.role,
          joinedAt: member.createdAt.toISOString(),
          status: member.status,
        },
      },
      requestId,
      200,
    );
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
