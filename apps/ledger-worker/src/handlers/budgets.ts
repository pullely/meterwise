import { BUDGET_DEFAULT_TENANT, budgetPeriod, formatUsd, type ListBudgetsResponse, type PublicBudget } from "@saas/contracts/ledger";
import type { Budget } from "@saas/db/ledger";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { recordAudit } from "../audit.js";
import { nowIso, type Db } from "../context.js";
import { notFound, successResponse, validationError } from "../http.js";
import { actorRef, budgetPublicId } from "../ids.js";
import { parseTenantSegment, validateBudgetBody } from "../validate.js";
import { invalidJson, readJson, withDb } from "./common.js";

async function present(db: Db, orgId: string, b: Budget, period: string): Promise<PublicBudget> {
  const spent = b.tenant === BUDGET_DEFAULT_TENANT ? null : ((await db.guard.getSpend(orgId, b.tenant, period))?.costNanoUsd ?? 0);
  return {
    id: budgetPublicId(b.id),
    tenant: b.tenant,
    softLimitNanoUsd: b.softLimitNanoUsd,
    softLimitUsd: b.softLimitNanoUsd === null ? null : formatUsd(b.softLimitNanoUsd),
    hardLimitNanoUsd: b.hardLimitNanoUsd,
    hardLimitUsd: b.hardLimitNanoUsd === null ? null : formatUsd(b.hardLimitNanoUsd),
    downgrade: b.downgrade,
    period,
    spentNanoUsd: spent,
    spentUsd: spent === null ? null : formatUsd(spent),
    updatedAt: b.updatedAt,
  };
}

/** GET /v1/organizations/{org}/budgets — every budget with its tenant's month-to-date spend. */
export async function handleListBudgets(_request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "ledger.read", async (db) => {
    const period = budgetPeriod(nowIso());
    const budgets = await db.guard.listBudgets(orgId);
    const body: ListBudgetsResponse = { period, budgets: await Promise.all(budgets.map((b) => present(db, orgId, b, period))) };
    return successResponse(body, requestId);
  });
}

/** GET /v1/organizations/{org}/budgets/{tenant} — "*" is the org-wide default. */
export async function handleGetBudget(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segment: string,
): Promise<Response> {
  const tenant = parseTenantSegment(segment);
  if (tenant === null) return notFound(requestId);
  return withDb(env, requestId, actor, orgId, "ledger.read", async (db) => {
    const b = await db.guard.getBudget(orgId, tenant);
    if (!b) return notFound(requestId);
    return successResponse(await present(db, orgId, b, budgetPeriod(nowIso())), requestId);
  });
}

/** PUT /v1/organizations/{org}/budgets/{tenant} — create or replace; 201 on create, 200 on replace. Audited. */
export async function handlePutBudget(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segment: string,
): Promise<Response> {
  const tenant = parseTenantSegment(segment);
  if (tenant === null) return notFound(requestId);
  const parsed = await readJson(request);
  if (!parsed.ok) return invalidJson(requestId);
  return withDb(env, requestId, actor, orgId, "ledger.budget.write", async (db) => {
    const v = validateBudgetBody(parsed.body);
    if (!v.valid) return validationError(requestId, v.fields);
    const now = nowIso();
    const { budget, created } = await db.guard.putBudget({
      id: crypto.randomUUID(),
      orgId,
      tenant,
      ...v.value,
      createdAt: now,
      updatedAt: now,
      updatedBy: actorRef(actor.subjectId),
    });
    await recordAudit(db.executor, {
      type: "ledger.budget.set",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "ledger_budget",
      subjectId: budget.id,
      subjectName: tenant === BUDGET_DEFAULT_TENANT ? "Default budget" : `Budget for ${tenant}`,
      description: `${created ? "Set" : "Changed"} the monthly LLM budget for ${tenant === BUDGET_DEFAULT_TENANT ? "every tenant without its own" : `tenant "${tenant}"`}`,
      payload: {
        budgetId: budgetPublicId(budget.id),
        tenant,
        softLimitNanoUsd: budget.softLimitNanoUsd,
        hardLimitNanoUsd: budget.hardLimitNanoUsd,
        downgrade: budget.downgrade,
        created,
      },
      occurredAt: now,
    });
    return successResponse(await present(db, orgId, budget, budgetPeriod(now)), requestId, created ? 201 : 200);
  });
}

/** DELETE /v1/organizations/{org}/budgets/{tenant} — 404 when there is none. Audited. */
export async function handleDeleteBudget(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segment: string,
): Promise<Response> {
  const tenant = parseTenantSegment(segment);
  if (tenant === null) return notFound(requestId);
  return withDb(env, requestId, actor, orgId, "ledger.budget.write", async (db) => {
    const removed = await db.guard.deleteBudget(orgId, tenant);
    if (!removed) return notFound(requestId);
    const now = nowIso();
    await recordAudit(db.executor, {
      type: "ledger.budget.removed",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "ledger_budget",
      subjectId: removed.id,
      subjectName: tenant === BUDGET_DEFAULT_TENANT ? "Default budget" : `Budget for ${tenant}`,
      description: `Removed the monthly LLM budget for ${tenant === BUDGET_DEFAULT_TENANT ? "every tenant without its own" : `tenant "${tenant}"`}`,
      payload: { budgetId: budgetPublicId(removed.id), tenant },
      occurredAt: now,
    });
    return successResponse({ removed: await present(db, orgId, removed, budgetPeriod(now)) }, requestId);
  });
}
