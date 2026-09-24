import type { Env } from "../env.js";
import type { BillingRepository, Subscription } from "@saas/db/billing";
import type { EventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { createBillingRepository } from "@saas/db/billing";
import { createEventsRepository } from "@saas/db/events";
import { successResponse, errorResponse, validationError } from "../http.js";
import { parseOrgPublicId, generateUuid } from "../ids.js";
import {
  PLAN_CATALOG,
  getPlanDefinition,
  isKnownPlanCode,
  type PlanDefinition,
} from "../plan-catalog.js";

/**
 * Internal, service-binding-only seam that assigns a plan to an organization
 * (Task 0128 / B11). This single idempotent operation is the provider-neutral
 * subscription primitive — it covers both **create** (no active subscription
 * yet, e.g. org bootstrap → free) and **change** (upgrade/downgrade to a
 * different plan). It:
 *
 *   1. ensures the catalog plan rows exist (`createPlan` is ON CONFLICT DO
 *      NOTHING — no data migration needed),
 *   2. ensures a billing customer exists for the org (upsert by org),
 *   3. creates the active subscription (cancelling a prior active one on a
 *      plan change), and
 *   4. materializes the plan's entitlement set into `billing_entitlements`
 *      (idempotent upsert keyed on (org, key)) so `check-entitlement` reads
 *      real rows instead of the PR-#209 fallback,
 *   5. emits `subscription.created|updated` + `entitlements.updated` events.
 *
 * No payment provider, no secrets. Stripe wiring (B6) slots in behind the same
 * seam later; public upgrade/downgrade API + UX is U7.
 */

interface ParsedAssign {
  publicOrgId: string;
  orgId: string;
  planCode: string;
}

interface EventActor {
  type: string;
  id: string;
}

/**
 * Opaque payment-provider linkage stamped onto the billing customer +
 * subscription when a verified provider webhook drives the assignment. Absent
 * for the internal bootstrap path (org → free) and admin assignments, which have
 * no provider subscription. Without this, real subscriptions would have no
 * `provider_subscription_id` and thus couldn't be changed/canceled/charged.
 */
export interface ProviderLink {
  id: string;
  customerId?: string | null;
  subscriptionId?: string | null;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
}

export function parseAssignPlanBody(body: unknown): ParsedAssign | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "request body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;
  const rawOrgId = obj.orgId;
  const rawPlan = obj.planCode;
  if (typeof rawOrgId !== "string" || rawOrgId.length === 0) {
    return { error: "orgId is required" };
  }
  if (typeof rawPlan !== "string" || rawPlan.length === 0) {
    return { error: "planCode is required" };
  }
  if (!isKnownPlanCode(rawPlan)) {
    return { error: "planCode is not a known plan" };
  }
  const orgId = parseOrgPublicId(rawOrgId);
  if (!orgId) {
    return { error: "orgId is malformed" };
  }
  return { publicOrgId: rawOrgId, orgId, planCode: rawPlan };
}

export interface AssignPlanOutcome {
  kind: "ok";
  created: boolean;
  changed: boolean;
  planCode: string;
  subscriptionId: string;
  entitlementKeys: string[];
}

export type AssignPlanResult = AssignPlanOutcome | { kind: "repo_error" };

type BillingRepoSlice = Pick<
  BillingRepository,
  | "createPlan"
  | "getPlanByCode"
  | "upsertBillingCustomer"
  | "getActiveSubscription"
  | "createSubscription"
  | "updateSubscription"
  | "upsertEntitlement"
>;
type EventsRepoSlice = Pick<EventsRepository, "appendEventWithAudit">;

/**
 * Orchestration over repositories, free of any executor/transaction knowledge
 * so it can be unit-tested with fakes. Returns `repo_error` on the first
 * critical (subscription/entitlement) repository failure; event emission is
 * best-effort and never fails the assignment.
 */
export async function assignPlanWithRepos(
  repo: BillingRepoSlice,
  events: EventsRepoSlice | null,
  parsed: ParsedAssign,
  def: PlanDefinition,
  opts: {
    now: Date;
    genId: () => string;
    actor: EventActor;
    requestId: string;
    provider?: ProviderLink;
  },
): Promise<AssignPlanResult> {
  const { now, genId, actor, requestId, provider } = opts;

  // 1. Ensure the catalog plan rows exist (idempotent).
  for (const p of PLAN_CATALOG) {
    const r = await repo.createPlan({
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      status: "active",
      billingInterval: p.billingInterval,
      priceAmountCents: p.priceAmountCents,
      priceCurrency: p.priceCurrency,
    });
    // createPlan is ON CONFLICT (code) DO NOTHING; an existing row returns
    // not_found/conflict which is fine here. Only a hard internal error aborts.
    if (!r.ok && r.error.kind === "internal") return { kind: "repo_error" };
  }
  const planRes = await repo.getPlanByCode(def.code);
  if (!planRes.ok) return { kind: "repo_error" };
  const plan = planRes.value;

  // 2. Ensure a billing customer for the org (upsert by org_id). When a verified
  //    provider webhook drives this, stamp the opaque provider linkage so the
  //    customer mirrors the provider record (and back-fills earlier rows).
  const custRes = await repo.upsertBillingCustomer({
    id: genId(),
    orgId: parsed.orgId,
    status: "active",
    ...(provider
      ? { provider: provider.id, providerCustomerId: provider.customerId ?? null }
      : {}),
  });
  if (!custRes.ok) return { kind: "repo_error" };
  const customerId = custRes.value.id;

  // 3. Resolve the active subscription.
  const activeRes = await repo.getActiveSubscription(parsed.orgId);
  const active = activeRes.ok ? activeRes.value : null;
  if (!activeRes.ok && activeRes.error.kind === "internal") return { kind: "repo_error" };

  let subscription: Subscription;
  let created = false;
  let changed = false;

  if (active && active.planId === plan.id) {
    // Same plan already active → idempotent re-materialization. Still refresh the
    // provider linkage + billing period from the webhook (renewals; and back-fill
    // a subscription created before provider linkage was recorded).
    subscription = active;
    if (provider) {
      const upd = await repo.updateSubscription(parsed.orgId, active.id, {
        status: "active",
        provider: provider.id,
        providerSubscriptionId: provider.subscriptionId ?? null,
        ...(provider.currentPeriodStart ? { currentPeriodStart: provider.currentPeriodStart } : {}),
        ...(provider.currentPeriodEnd ? { currentPeriodEnd: provider.currentPeriodEnd } : {}),
      });
      if (upd.ok) subscription = upd.value;
      else if (upd.error.kind === "internal") return { kind: "repo_error" };
    }
  } else {
    if (active) {
      // Plan change → cancel the prior active subscription.
      const cancelRes = await repo.updateSubscription(parsed.orgId, active.id, {
        status: "canceled",
        canceledAt: now,
      });
      if (!cancelRes.ok) return { kind: "repo_error" };
      changed = true;
    }
    const createRes = await repo.createSubscription({
      id: genId(),
      orgId: parsed.orgId,
      billingCustomerId: customerId,
      planId: plan.id,
      status: "active",
      currentPeriodStart: provider?.currentPeriodStart ?? now,
      ...(provider
        ? {
            provider: provider.id,
            providerSubscriptionId: provider.subscriptionId ?? null,
            currentPeriodEnd: provider.currentPeriodEnd ?? null,
          }
        : {}),
    });
    if (!createRes.ok) return { kind: "repo_error" };
    subscription = createRes.value;
    created = true;
  }

  // 4. Materialize the plan's entitlement set (idempotent upsert per key).
  for (const e of def.entitlements) {
    const r = await repo.upsertEntitlement({
      id: genId(),
      orgId: parsed.orgId,
      subscriptionId: subscription.id,
      entitlementKey: e.entitlementKey,
      valueType: e.valueType,
      enabled: e.enabled,
      limitValue: e.limitValue,
      source: "plan",
    });
    if (!r.ok) return { kind: "repo_error" };
  }

  const entitlementKeys = def.entitlements.map((e) => e.entitlementKey);

  // 5. Best-effort events (never fail the assignment).
  if (events) {
    await emitEvents(events, parsed, plan.code, subscription.id, entitlementKeys, {
      now,
      genId,
      actor,
      requestId,
      created,
    });
  }

  return {
    kind: "ok",
    created,
    changed,
    planCode: plan.code,
    subscriptionId: subscription.id,
    entitlementKeys,
  };
}

async function emitEvents(
  events: EventsRepoSlice,
  parsed: ParsedAssign,
  planCode: string,
  subscriptionId: string,
  entitlementKeys: string[],
  opts: { now: Date; genId: () => string; actor: EventActor; requestId: string; created: boolean },
): Promise<void> {
  const { now, genId, actor, requestId, created } = opts;
  try {
    await events.appendEventWithAudit({
      event: {
        id: genId(),
        type: created ? "subscription.created" : "subscription.updated",
        version: 1,
        source: "billing-worker",
        occurredAt: now,
        actorType: actor.type,
        actorId: actor.id,
        orgId: parsed.orgId,
        subjectKind: "subscription",
        subjectId: subscriptionId,
        requestId,
        payload: { orgId: parsed.publicOrgId, planCode },
      },
      audit: {
        id: genId(),
        category: "billing",
        description: `Subscription ${created ? "created" : "updated"} on plan "${planCode}"`,
      },
    });
    await events.appendEventWithAudit({
      event: {
        id: genId(),
        type: "entitlements.updated",
        version: 1,
        source: "billing-worker",
        occurredAt: now,
        actorType: actor.type,
        actorId: actor.id,
        orgId: parsed.orgId,
        subjectKind: "organization",
        subjectId: parsed.orgId,
        requestId,
        payload: { orgId: parsed.publicOrgId, planCode, entitlementKeys },
      },
      audit: {
        id: genId(),
        category: "billing",
        description: `Entitlements updated from plan "${planCode}"`,
      },
    });
  } catch {
    // Best-effort: the subscription + entitlement rows are already persisted and
    // are what gate product behavior. A missed event must not fail the assign.
  }
}

export interface AssignPlanDeps {
  repoFactory?: (env: Env) => BillingRepoSlice;
  eventsFactory?: (env: Env) => EventsRepoSlice;
  now?: () => Date;
  generateId?: () => string;
}

function resolveActor(request: Request): EventActor {
  const id = request.headers.get("x-actor-subject-id");
  const type = request.headers.get("x-actor-subject-type");
  if (id && type) return { id, type };
  return { id: "system", type: "system" };
}

export async function handleAssignPlan(
  request: Request,
  env: Env,
  requestId: string,
  deps: AssignPlanDeps = {},
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed", 405, requestId);
  }
  if (!deps.repoFactory && !env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service misconfigured", 503, requestId);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationError(requestId, "request body is not valid JSON");
  }
  const parsed = parseAssignPlanBody(payload);
  if ("error" in parsed) {
    return validationError(requestId, parsed.error);
  }
  const def = getPlanDefinition(parsed.planCode)!; // validated in parse
  const now = deps.now ? deps.now() : new Date();
  const genId = deps.generateId ?? generateUuid;
  const actor = resolveActor(request);

  // Injected-deps path (unit tests): no executor/transaction.
  if (deps.repoFactory) {
    const repo = deps.repoFactory(env);
    const events = deps.eventsFactory ? deps.eventsFactory(env) : null;
    const outcome = await assignPlanWithRepos(repo, events, parsed, def, { now, genId, actor, requestId });
    return finalize(outcome, requestId);
  }

  // Production path: wrap subscription + entitlement + events atomically.
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  try {
    if ("transaction" in executor) {
      const outcome = await executor.transaction(async (txExec) => {
        const repo = createBillingRepository(txExec);
        const events = createEventsRepository(txExec);
        return assignPlanWithRepos(repo, events, parsed, def, { now, genId, actor, requestId });
      });
      return finalize(outcome, requestId);
    }
    const repo = createBillingRepository(executor);
    const events = createEventsRepository(executor);
    const outcome = await assignPlanWithRepos(repo, events, parsed, def, { now, genId, actor, requestId });
    return finalize(outcome, requestId);
  } catch {
    return errorResponse("internal_error", "Failed to assign plan", 503, requestId);
  } finally {
    if ("dispose" in executor && typeof executor.dispose === "function") {
      await executor.dispose();
    }
  }
}

function finalize(outcome: AssignPlanResult, requestId: string): Response {
  if (outcome.kind === "repo_error") {
    return errorResponse("internal_error", "Failed to assign plan", 503, requestId);
  }
  return successResponse(
    {
      planCode: outcome.planCode,
      subscriptionId: outcome.subscriptionId,
      created: outcome.created,
      changed: outcome.changed,
      entitlementKeys: outcome.entitlementKeys,
    },
    requestId,
  );
}
