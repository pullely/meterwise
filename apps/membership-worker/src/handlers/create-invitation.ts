import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { ORGANIZATION_ROLES } from "@saas/contracts/membership";
import { createSqlExecutor } from "@saas/db/d1";
import { createMembershipRepository } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { authorizeViaPolicy } from "../policy-client.js";
import {
  checkBillingEntitlement,
  decideMembersLimit,
} from "../billing-client.js";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, orgPublicId, invitationPublicId, generateInvitationToken } from "../ids.js";
import { enqueueNotification, buildIdempotencyKey, type EnqueueNotificationResult } from "@saas/notifications-client";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITATION_EXPIRY_DAYS = 7;
const MEMBERS_LIMIT_ENTITLEMENT_KEY = "limit.members";

export interface CreateInvitationDeps {
  repo: Pick<MembershipRepository, "listRoleAssignments" | "createInvitation" | "countBillableMembers">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  generateToken?: () => Promise<{ raw: string; hash: string }>;
  now?: () => Date;
  generateId?: () => string;
  /**
   * Injectable billing entitlement check for tests. Defaults to a real call
   * against env.BILLING_WORKER.
   */
  checkEntitlement?: typeof checkBillingEntitlement;
  /**
   * Injectable notifications enqueue for tests. When omitted on the deps
   * path, NO enqueue is attempted (tests opt in by passing this). The real
   * transactional path always calls the real `enqueueNotification` against
   * `env.NOTIFICATIONS_WORKER` (best-effort; absent binding is a no-op).
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

export async function handleCreateInvitation(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgIdParam: string,
  deps?: CreateInvitationDeps,
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

  const { email, role } = body as { email?: unknown; role?: unknown };

  const fields: Record<string, string[]> = {};
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    fields.email = ["A valid email address is required"];
  }
  if (typeof role !== "string" || !(ORGANIZATION_ROLES as readonly string[]).includes(role)) {
    fields.role = [`Role must be one of: ${ORGANIZATION_ROLES.join(", ")}`];
  }
  if (Object.keys(fields).length > 0) {
    return validationError(requestId, fields);
  }

  const validEmail = (email as string).trim();
  const validRole = role as string;

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  if (!env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  if (!deps && !env.BILLING_WORKER) {
    // Production code path: missing service binding fails closed before any
    // policy / repo work runs. Tests that inject `deps` provide their own
    // billing seam (or opt out entirely) and skip this check.
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }

  const policyWorker = env.POLICY_WORKER;
  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    const repo = deps ? deps.repo : createMembershipRepository(executor!);

    const rolesResult = await repo.listRoleAssignments(orgUuid, actor.subjectId);
    if (!rolesResult.ok) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    const authResult = await authorizeViaPolicy(policyWorker, {
      actor,
      action: "organization.invitation.create",
      resource: { kind: "organization", id: orgUuid, orgId: orgUuid },
      orgId: orgUuid,
      roleAssignments: rolesResult.value,
      requestId,
    });

    if (!authResult.allow) {
      return errorResponse("not_found", "Organization not found", 404, requestId);
    }

    // ── Billing entitlement gate (Task 0080) ─────────────────────
    // Invitation creation is gated on `limit.members` after policy allow and
    // before any invitation / event / audit row is written. The billable
    // count is `active members + pending invitations` so that pending
    // invitations occupy seats until they accept, expire, or are revoked.
    // Fails closed on any service / misconfiguration error.
    //
    // Tests that inject `deps` without an explicit `checkEntitlement` opt
    // out of the gate entirely — preserving the original seam for handler
    // tests that predate the gate. Production code path always passes
    // through `checkBillingEntitlement` against `env.BILLING_WORKER`, which
    // is asserted by the dedicated billing-gate test suite below.
    const skipBillingGate = deps !== undefined && !deps.checkEntitlement;
    if (!skipBillingGate) {
      const entitlementFn = deps?.checkEntitlement ?? checkBillingEntitlement;
      const billingBinding = env.BILLING_WORKER;
      if (!billingBinding && !deps?.checkEntitlement) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
      const entitlementResult = await entitlementFn(
        billingBinding as Fetcher,
        orgPublicId(orgUuid),
        MEMBERS_LIMIT_ENTITLEMENT_KEY,
        requestId,
      );
      if (entitlementResult.kind === "service_error") {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      const nowForGate = deps?.now ? deps.now() : new Date();
      const countResult = await repo.countBillableMembers(orgUuid, nowForGate);
      if (!countResult.ok) {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }

      const gate = decideMembersLimit(entitlementResult.decision, countResult.value);
      if (gate.kind === "service_error") {
        return errorResponse("internal_error", "Service unavailable", 503, requestId);
      }
      if (gate.kind === "deny") {
        return errorResponse(
          "precondition_failed",
          gate.message,
          412,
          requestId,
          { reason: gate.reason },
        );
      }
    }

    const now = deps?.now ? deps.now() : new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const tokenGen = deps?.generateToken ?? generateInvitationToken;
    const { raw: rawToken, hash: tokenHash } = await tokenGen();
    const invitationId = crypto.randomUUID();
    const genId = deps?.generateId ?? (() => randomHex(16));

    if (executor && "transaction" in executor) {
      const result = await executor.transaction(async (txExec) => {
        const txRepo = createMembershipRepository(txExec);
        const txEventsRepo = createEventsRepository(txExec);

        const createResult = await txRepo.createInvitation({
          id: invitationId,
          orgId: orgUuid,
          email: validEmail,
          emailLower: validEmail.toLowerCase(),
          role: validRole,
          tokenHash,
          invitedBy: actor.subjectId,
          expiresAt,
          createdAt: now,
        });

        if (!createResult.ok) {
          return { createResult };
        }

        const eventResult = await txEventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "invite.created",
            version: 1,
            source: "membership-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId: orgUuid,
            subjectKind: "invitation",
            subjectId: invitationId,
            requestId,
            payload: { invitationId: invitationPublicId(invitationId), role: validRole, expiresAt: expiresAt.toISOString() },
          },
          audit: {
            id: genId(),
            category: "membership",
            description: `Invitation ${invitationPublicId(invitationId)} created`,
          },
        });

        if (!eventResult.ok) {
          throw new Error("event_append_failed");
        }

        return { createResult };
      });

      if (!result.createResult.ok) {
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }

      const inv = result.createResult.value;
      const publicInv = {
        id: invitationPublicId(inv.id),
        email: inv.email,
        role: inv.role,
        status: deriveStatus(inv, now),
        invitedBy: inv.invitedBy,
        expiresAt: inv.expiresAt.toISOString(),
        createdAt: inv.createdAt.toISOString(),
        acceptedAt: inv.acceptedAt ? inv.acceptedAt.toISOString() : null,
        revokedAt: inv.revokedAt ? inv.revokedAt.toISOString() : null,
      };

      const isDebug = env.DEBUG_DELIVERY === "true";

      // Best-effort: enqueue an `invitation.created` notification AFTER the
      // transaction has committed successfully. A rolled-back invitation
      // must never produce a user-facing notification, so the enqueue lives
      // strictly outside the `executor.transaction(...)` callback. The
      // client never throws and handles all failure modes internally; the
      // 201 response below is identical whether the enqueue succeeded or
      // not. Skipped under DEBUG_DELIVERY === "true" to avoid duplicate
      // `local_debug` provider rows during developer flows (mirrors the
      // identity-worker choice).
      //
      // No raw token leaves the worker boundary in `templateData`. Only
      // redaction-safe, code-controlled fields are forwarded; the raw token
      // remains in the existing `delivery: { mode: "local_debug", token }`
      // response-body path only.
      if (!isDebug) {
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
            templateKey: "invitation.created",
            templateData: {
              role: validRole,
              invitationId: invitationPublicId(inv.id),
              expiresAt: inv.expiresAt.toISOString(),
              invitedBy: inv.invitedBy,
              orgId: orgPublicId(orgUuid),
            },
            recipient: {
              channel: "email",
              address: validEmail.toLowerCase(),
            },
            // Stripe-quality idempotency: a retry of this same
            // post-commit enqueue (same `inv.id`, same logical
            // invitation create) must collapse to one notification
            // row + one provider attempt. `inv.id` is the durable
            // UUID materialised inside the prior `txRepo.createInvitation`
            // commit — stable across retries, scoped per-org, never
            // secret. Template-scoped to prevent collision with
            // `invitation.accepted` on the same invitation.
            idempotencyKey: buildIdempotencyKey(
              "invitation.created",
              invitationPublicId(inv.id),
            ),
            correlationId: requestId,
          },
        );
      }

      const responseData: Record<string, unknown> = { invitation: publicInv };
      if (isDebug) {
        responseData.delivery = { mode: "local_debug", token: rawToken };
      }

      return successResponse(responseData, requestId, 201);
    }

    // Non-transactional path (unit tests with injected deps)
    const createResult = await repo.createInvitation({
      id: invitationId,
      orgId: orgUuid,
      email: validEmail,
      emailLower: validEmail.toLowerCase(),
      role: validRole,
      tokenHash,
      invitedBy: actor.subjectId,
      expiresAt,
      createdAt: now,
    });

    if (!createResult.ok) {
      return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
    }

    if (deps?.eventsRepo) {
      const eventResult = await deps.eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: "invite.created",
          version: 1,
          source: "membership-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId: orgUuid,
          subjectKind: "invitation",
          subjectId: invitationId,
          requestId,
          payload: { invitationId: invitationPublicId(invitationId), role: validRole, expiresAt: expiresAt.toISOString() },
        },
        audit: {
          id: genId(),
          category: "membership",
          description: `Invitation ${invitationPublicId(invitationId)} created`,
        },
      });

      if (!eventResult.ok) {
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }
    }

    const inv = createResult.value;
    const publicInv = {
      id: invitationPublicId(inv.id),
      email: inv.email,
      role: inv.role,
      status: deriveStatus(inv, now),
      invitedBy: inv.invitedBy,
      expiresAt: inv.expiresAt.toISOString(),
      createdAt: inv.createdAt.toISOString(),
      acceptedAt: inv.acceptedAt ? inv.acceptedAt.toISOString() : null,
      revokedAt: inv.revokedAt ? inv.revokedAt.toISOString() : null,
    };

    const isDebug = env.DEBUG_DELIVERY === "true";

    // Deps (non-transactional) path: only enqueue when the caller has
    // explicitly injected a notifications client. The default deps path
    // (older unit tests that predate notifications) MUST NOT attempt an
    // enqueue. DEBUG_DELIVERY short-circuit matches the real path.
    if (!isDebug && deps?.enqueueNotification) {
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
          templateKey: "invitation.created",
          templateData: {
            role: validRole,
            invitationId: invitationPublicId(inv.id),
            expiresAt: inv.expiresAt.toISOString(),
            invitedBy: inv.invitedBy,
            orgId: orgPublicId(orgUuid),
          },
          recipient: {
            channel: "email",
            address: validEmail.toLowerCase(),
          },
          // Same idempotency contract as the transactional path; see
          // the comment block above for the full rationale.
          idempotencyKey: buildIdempotencyKey(
            "invitation.created",
            invitationPublicId(inv.id),
          ),
          correlationId: requestId,
        },
      );
    }

    const responseData: Record<string, unknown> = { invitation: publicInv };
    if (isDebug) {
      responseData.delivery = { mode: "local_debug", token: rawToken };
    }

    return successResponse(responseData, requestId, 201);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}

function deriveStatus(inv: { status: string; expiresAt: Date; acceptedAt: Date | null; revokedAt: Date | null }, now: Date): string {
  if (inv.revokedAt) return "revoked";
  if (inv.acceptedAt) return "accepted";
  if (inv.status === "pending" && inv.expiresAt < now) return "expired";
  return inv.status;
}
