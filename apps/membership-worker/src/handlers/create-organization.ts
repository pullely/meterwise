import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type { MembershipRepository, MembershipResult, Organization } from "@saas/db/membership";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { createMembershipRepository, effectiveBillingOrgId } from "@saas/db/membership";
import { createEventsRepository } from "@saas/db/events";
import { successResponse, errorResponse, validationError } from "../http.js";
import { orgPublicId, memberPublicId } from "../ids.js";
import { asUuid } from "@saas/db/ids";
import {
  assignPlan,
  checkBillingEntitlement,
  decideOrgCreationGate,
  fanOutPlan,
  type AssignPlanResult,
  type FanOutResult,
} from "../billing-client.js";
import { isSoloMode } from "../solo-mode.js";

/** Plan code assigned to every organization at bootstrap. Stable contract with
 * billing-worker's plan catalog (plan-catalog.ts DEFAULT_PLAN_CODE). */
const BOOTSTRAP_PLAN_CODE = "free";

/** Multi-org entitlement keys checked against the account's billing parent (MO2). */
const MULTI_ORG_FEATURE_KEY = "feature.multi_org";
const ORGANIZATIONS_LIMIT_KEY = "limit.organizations";

const NAME_MIN = 1;
const NAME_MAX = 100;
const SLUG_MIN = 2;
const SLUG_MAX = 63;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

interface CreateOrgBody {
  name?: unknown;
  slug?: unknown;
}

export interface CreateOrganizationDeps {
  repo: Pick<MembershipRepository, "bootstrapOrganization">;
  eventsRepo?: Pick<EventsRepository, "appendEventWithAudit">;
  now?: () => Date;
  generateId?: () => string;
  /** Injected best-effort plan-assignment seam for unit tests. When omitted in
   * the deps path, bootstrap skips the billing call entirely. */
  assignPlan?: (orgPublicId: string) => Promise<AssignPlanResult>;
  /**
   * Injectable entitlement check for the MO2 additional-org gate. When `deps`
   * is provided WITHOUT this, the gate is skipped entirely (preserves the
   * pre-MO2 handler tests). Production always uses `checkBillingEntitlement`.
   */
  checkEntitlement?: typeof checkBillingEntitlement;
  /** Injectable "orgs this subject belongs to" lookup for the gate (tests). */
  listOrgsForSubject?: (subjectId: string) => Promise<MembershipResult<Organization[]>>;
  /** Injectable child entitlement fan-out seam for tests (MO3). */
  fanOut?: (parentOrgPublicId: string, childOrgPublicId: string) => Promise<FanOutResult>;
}

/** Outcome of the MO2/MO3 gate: proceed standalone, proceed as a child of a
 * billing parent (MO3), or block with a Response. */
type GateOutcome =
  | { kind: "allow" }
  | { kind: "allow_child"; parentOrgIdHex: string }
  | { kind: "block"; response: Response };

/**
 * MO2 gate: creating an *additional* org (the account already owns ≥1) requires
 * the billing parent to have `feature.multi_org` enabled and to be under
 * `limit.organizations`. The first/bootstrap org is always allowed. The billing
 * parent is the account's earliest-created org (resolved through
 * `effectiveBillingOrgId`). Fails closed (503) on any service/repo error.
 *
 * Under the M0/Solo profile the account is capped at its one personal org, so an
 * additional org is denied outright — before (and independent of) the billing
 * entitlement checks, since an upgraded Solo account would otherwise pass them.
 * The bootstrap org stays allowed: that is the path auto-provisioning and the
 * console's onboarding fallback both use. See ../solo-mode.ts.
 *
 * Returns `allow` (bootstrap/standalone), `allow_child` (additional org → link
 * to the billing parent and fan out its plan, MO3), or `block` (deny/error).
 */
async function gateAdditionalOrg(
  env: Env,
  actor: ActorContext,
  requestId: string,
  deps: CreateOrganizationDeps | undefined,
  gateRepo: Pick<MembershipRepository, "listOrganizationsForSubject"> | null,
): Promise<GateOutcome> {
  // Skip the gate for the legacy deps path that doesn't opt into billing.
  if (deps && !deps.checkEntitlement) return { kind: "allow" };

  const listFn =
    deps?.listOrgsForSubject ??
    (gateRepo ? (sid: string) => gateRepo.listOrganizationsForSubject(sid) : null);
  if (!listFn) return { kind: "allow" }; // no way to read the account; bootstrap-safe

  const orgsRes = await listFn(actor.subjectId);
  if (!orgsRes.ok) {
    return { kind: "block", response: errorResponse("internal_error", "Service unavailable", 503, requestId) };
  }
  const existing = orgsRes.value;
  if (existing.length === 0) return { kind: "allow" }; // first/bootstrap org — always allowed

  // Solo profile: the user IS the tenant — one org per account, full stop. This
  // is the enforcement the api-edge used to approximate by 404-ing the whole
  // verb; here it can distinguish the bootstrap (allowed above) from a second
  // org, and it holds even for an account whose plan grants `feature.multi_org`.
  if (isSoloMode(env)) {
    return {
      kind: "block",
      response: errorResponse(
        "forbidden",
        "This account cannot create additional organizations",
        403,
        requestId,
        { reason: "solo_profile" },
      ),
    };
  }

  const entitlementFn = deps?.checkEntitlement ?? checkBillingEntitlement;
  const billingBinding = env.BILLING_WORKER;
  if (!billingBinding && !deps?.checkEntitlement) {
    return { kind: "block", response: errorResponse("internal_error", "Service unavailable", 503, requestId) };
  }

  // Billing parent = the account's earliest-created org, via effectiveBillingOrgId.
  const parent = existing.reduce((a, b) =>
    a.createdAt.getTime() <= b.createdAt.getTime() ? a : b,
  );
  const parentOrgIdHex = effectiveBillingOrgId(parent);
  const parentPublicId = orgPublicId(parentOrgIdHex);

  const multiOrg = await entitlementFn(billingBinding as Fetcher, parentPublicId, MULTI_ORG_FEATURE_KEY, requestId);
  if (multiOrg.kind === "service_error") {
    return { kind: "block", response: errorResponse("internal_error", "Service unavailable", 503, requestId) };
  }
  const orgsLimit = await entitlementFn(billingBinding as Fetcher, parentPublicId, ORGANIZATIONS_LIMIT_KEY, requestId);
  if (orgsLimit.kind === "service_error") {
    return { kind: "block", response: errorResponse("internal_error", "Service unavailable", 503, requestId) };
  }

  const gate = decideOrgCreationGate(multiOrg.decision, orgsLimit.decision, existing.length);
  if (gate.kind === "service_error") {
    return { kind: "block", response: errorResponse("internal_error", "Service unavailable", 503, requestId) };
  }
  if (gate.kind === "deny") {
    return { kind: "block", response: errorResponse("precondition_failed", gate.message, 412, requestId, { reason: gate.reason }) };
  }
  return { kind: "allow_child", parentOrgIdHex };
}

/**
 * Best-effort: fan out the billing parent's plan entitlements onto a new child
 * org (MO3). NEVER fails creation — a transient failure is reconciled by the
 * next parent plan event (re-fan-out) and the check-entitlement free-tier
 * safety net keeps required flows working meanwhile.
 */
async function tryFanOut(
  env: Env,
  parentOrgIdHex: string,
  childOrgIdHex: string,
  actor: ActorContext,
  requestId: string,
): Promise<void> {
  const binding = env.BILLING_WORKER;
  if (!binding) return;
  try {
    await fanOutPlan(binding as Fetcher, orgPublicId(parentOrgIdHex), orgPublicId(childOrgIdHex), requestId, {
      id: actor.subjectId,
      type: actor.subjectType,
    });
  } catch {
    /* best-effort */
  }
}

/**
 * Best-effort: grant the free plan so the new org gets real entitlement rows
 * (Task 0128). NEVER fails the bootstrap — a transient billing failure falls
 * back to the check-entitlement free-tier safety net until a later assignment
 * succeeds.
 */
async function tryAssignFreePlan(
  env: Env,
  orgUuid: string,
  actor: ActorContext,
  requestId: string,
): Promise<void> {
  const binding = env.BILLING_WORKER;
  if (!binding) return;
  try {
    await assignPlan(binding as Fetcher, orgPublicId(orgUuid), BOOTSTRAP_PLAN_CODE, requestId, {
      id: actor.subjectId,
      type: actor.subjectType,
    });
  } catch {
    /* best-effort */
  }
}

function generateSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
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

export async function handleCreateOrganization(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  deps?: CreateOrganizationDeps,
): Promise<Response> {
  let body: CreateOrgBody;
  try {
    body = (await request.json()) as CreateOrgBody;
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  const fields: Record<string, string[]> = {};

  if (typeof body.name !== "string" || body.name.length < NAME_MIN || body.name.length > NAME_MAX) {
    fields.name = [`Must be between ${NAME_MIN} and ${NAME_MAX} characters`];
  }

  let slug: string;
  if (body.slug !== undefined) {
    if (typeof body.slug !== "string" || body.slug.length < SLUG_MIN || body.slug.length > SLUG_MAX) {
      fields.slug = [`Must be between ${SLUG_MIN} and ${SLUG_MAX} characters`];
    } else if (!SLUG_RE.test(body.slug.toLowerCase())) {
      fields.slug = ["Must contain only lowercase letters, numbers, and hyphens, and start/end with alphanumeric"];
    }
    slug = body.slug as string;
  } else if (typeof body.name === "string") {
    slug = generateSlugFromName(body.name);
    if (slug.length < SLUG_MIN) {
      slug = `org-${slug || crypto.randomUUID().slice(0, 8)}`;
    }
  } else {
    slug = "";
  }

  if (Object.keys(fields).length > 0) {
    return validationError(requestId, fields);
  }

  if (!deps && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Database not configured", 503, requestId);
  }

  const now = deps?.now ? deps.now() : new Date();
  const genId = deps?.generateId ?? (() => randomHex(16));
  const orgId = asUuid(crypto.randomUUID());
  const memberId = crypto.randomUUID();
  const roleAssignmentId = crypto.randomUUID();
  const orgName = body.name as string;
  const slugLower = slug.toLowerCase();

  const bootstrapInput = {
    org: { id: orgId, name: orgName, slug, slugLower, parentOrgId: null as string | null, createdAt: now },
    member: { id: memberId, orgId, subjectId: actor.subjectId, subjectType: actor.subjectType, createdAt: now },
    roleAssignment: { id: roleAssignmentId, orgId, subjectId: actor.subjectId, subjectType: actor.subjectType, role: "owner", scopeKind: "organization", scopeRef: null, createdAt: now },
  };

  const executor = deps ? null : createSqlExecutor(env.PLATFORM_DB!);
  try {
    // MO2 gate / MO3 child linkage: an *additional* org is gated, then linked to
    // and fanned out from the account's billing parent. Bootstrap is exempt.
    const gateRepo = executor ? createMembershipRepository(executor) : null;
    const gate = await gateAdditionalOrg(env, actor, requestId, deps, gateRepo);
    if (gate.kind === "block") return gate.response;
    const parentOrgIdHex = gate.kind === "allow_child" ? gate.parentOrgIdHex : null;
    if (parentOrgIdHex) bootstrapInput.org.parentOrgId = parentOrgIdHex;

    if (executor && "transaction" in executor) {
      const result = await executor.transaction(async (txExec) => {
        const txRepo = createMembershipRepository(txExec);
        const txEventsRepo = createEventsRepository(txExec);

        const bootstrapResult = await txRepo.bootstrapOrganization(bootstrapInput);
        if (!bootstrapResult.ok) {
          return { bootstrapResult };
        }

        const orgEventResult = await txEventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "organization.created",
            version: 1,
            source: "membership-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId,
            subjectKind: "organization",
            subjectId: orgId,
            subjectName: orgName,
            requestId,
            payload: { orgId: orgPublicId(orgId), name: orgName, slug },
          },
          audit: {
            id: genId(),
            category: "membership",
            description: `Organization ${orgPublicId(orgId)} created`,
          },
        });

        if (!orgEventResult.ok) {
          throw new Error("event_append_failed");
        }

        const memberEventResult = await txEventsRepo.appendEventWithAudit({
          event: {
            id: genId(),
            type: "membership.added",
            version: 1,
            source: "membership-worker",
            occurredAt: now,
            actorType: actor.subjectType,
            actorId: actor.subjectId,
            orgId,
            subjectKind: "member",
            subjectId: memberId,
            requestId,
            payload: { orgId: orgPublicId(orgId), memberId: memberPublicId(memberId), subjectType: actor.subjectType, subjectId: actor.subjectId, role: "owner" },
          },
          audit: {
            id: genId(),
            category: "membership",
            description: `Member ${memberPublicId(memberId)} added as owner`,
          },
        });

        if (!memberEventResult.ok) {
          throw new Error("event_append_failed");
        }

        return { bootstrapResult };
      });

      if (!result.bootstrapResult.ok) {
        if (result.bootstrapResult.error.kind === "conflict") {
          return errorResponse("conflict", "Organization already exists", 409, requestId);
        }
        return errorResponse("internal_error", "Failed to create organization", 500, requestId);
      }

      const { org, roleAssignment } = result.bootstrapResult.value;
      // A child inherits the parent's plan (fan-out); a standalone org gets free.
      if (parentOrgIdHex) {
        await tryFanOut(env, parentOrgIdHex, org.id, actor, requestId);
      } else {
        await tryAssignFreePlan(env, org.id, actor, requestId);
      }
      return successResponse(
        {
          organization: { id: orgPublicId(org.id), name: org.name, slug: org.slug, createdAt: org.createdAt.toISOString() },
          membership: { role: roleAssignment.role, joinedAt: result.bootstrapResult.value.member.createdAt.toISOString() },
        },
        requestId,
        201,
      );
    }

    // Non-transactional path (unit tests with injected deps)
    const repo = deps!.repo;
    const bootstrapResult = await repo.bootstrapOrganization(bootstrapInput);
    if (!bootstrapResult.ok) {
      if (bootstrapResult.error.kind === "conflict") {
        return errorResponse("conflict", "Organization already exists", 409, requestId);
      }
      return errorResponse("internal_error", "Failed to create organization", 500, requestId);
    }

    if (deps?.eventsRepo) {
      const orgEventResult = await deps.eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: "organization.created",
          version: 1,
          source: "membership-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          subjectKind: "organization",
          subjectId: orgId,
          subjectName: orgName,
          requestId,
          payload: { orgId: orgPublicId(orgId), name: orgName, slug },
        },
        audit: {
          id: genId(),
          category: "membership",
          description: `Organization ${orgPublicId(orgId)} created`,
        },
      });

      if (!orgEventResult.ok) {
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }

      const memberEventResult = await deps.eventsRepo.appendEventWithAudit({
        event: {
          id: genId(),
          type: "membership.added",
          version: 1,
          source: "membership-worker",
          occurredAt: now,
          actorType: actor.subjectType,
          actorId: actor.subjectId,
          orgId,
          subjectKind: "member",
          subjectId: memberId,
          requestId,
          payload: { orgId: orgPublicId(orgId), memberId: memberPublicId(memberId), subjectType: actor.subjectType, subjectId: actor.subjectId, role: "owner" },
        },
        audit: {
          id: genId(),
          category: "membership",
          description: `Member ${memberPublicId(memberId)} added as owner`,
        },
      });

      if (!memberEventResult.ok) {
        return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
      }
    }

    const { org, member, roleAssignment } = bootstrapResult.value;
    if (parentOrgIdHex && deps?.fanOut) {
      try {
        await deps.fanOut(orgPublicId(parentOrgIdHex), orgPublicId(org.id));
      } catch {
        /* best-effort */
      }
    } else if (deps?.assignPlan) {
      try {
        await deps.assignPlan(orgPublicId(org.id));
      } catch {
        /* best-effort */
      }
    }
    return successResponse(
      {
        organization: { id: orgPublicId(org.id), name: org.name, slug: org.slug, createdAt: org.createdAt.toISOString() },
        membership: { role: roleAssignment.role, joinedAt: member.createdAt.toISOString() },
      },
      requestId,
      201,
    );
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    if (executor) await executor.dispose();
  }
}
