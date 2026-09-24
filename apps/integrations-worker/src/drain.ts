// The inbox drain (design §6): attribute → lifecycle/normalize → emit.
//
// Mirrors the shipped outbound webhooks discipline, opposite direction:
// cron + table + bounded retries, no Queues. Each delivery is processed
// independently; emission into event_log happens in the same transaction
// that marks the delivery `emitted` (exactly-once by construction, R3).

import type { Env } from "./env.js";
import {
  INTEGRATION_EVENT_TYPES,
  type IntegrationEventType,
  type ScmEventType,
} from "@saas/contracts/integrations";
import {
  createIntegrationsRepository,
  type InboundDelivery,
  type IntegrationConnection,
  type IntegrationsRepository,
} from "@saas/db/integrations";
import { createEventsRepository, type EventsRepository } from "@saas/db/events";
import type { SqlExecutor } from "@saas/db/d1";
import { asUuid } from "@saas/db/ids";
import { generateUuid, inboundDeliveryPublicId, orgPublicId, projectPublicId } from "./ids.js";
import {
  installationIdFromPayload,
  LIFECYCLE_EVENT_TYPES,
  normalizeScmEvent,
} from "./normalize.js";

const DEFAULT_BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;
/** Retry backoff: 1m, 2m, 4m, 8m (then terminal `failed`). */
function backoffMs(attempts: number): number {
  return Math.min(2 ** (attempts - 1), 16) * 60_000;
}

export type DeliveryOutcome =
  | { kind: "emitted"; eventType: string }
  | { kind: "skipped"; reason: string }
  | { kind: "retried"; attempts: number }
  | { kind: "failed"; reason: string };

export interface DrainSummary {
  processed: number;
  emitted: number;
  skipped: number;
  retried: number;
  failed: number;
}

interface ProcessCtx {
  executor: SqlExecutor;
  repo: IntegrationsRepository;
  events: EventsRepository;
  now: () => Date;
}

async function markSkipped(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
  reason: string,
  attribution?: { orgId: string; connectionId: string },
): Promise<DeliveryOutcome> {
  await ctx.repo.markInboundDelivery(asUuid(delivery.id), {
    status: "skipped",
    failureReason: reason,
    ...(attribution
      ? { orgId: asUuid(attribution.orgId), connectionId: asUuid(attribution.connectionId) }
      : {}),
  });
  return { kind: "skipped", reason };
}

async function markRetryOrFail(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
  reason: string,
): Promise<DeliveryOutcome> {
  const attempts = delivery.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await ctx.repo.markInboundDelivery(asUuid(delivery.id), {
      status: "failed",
      attempts,
      nextAttemptAt: null,
      failureReason: reason,
    });
    return { kind: "failed", reason };
  }
  await ctx.repo.markInboundDelivery(asUuid(delivery.id), {
    attempts,
    nextAttemptAt: new Date(ctx.now().getTime() + backoffMs(attempts)),
    failureReason: reason,
  });
  return { kind: "retried", attempts };
}

/**
 * Emit one event and mark the delivery `emitted` transactionally when the
 * executor supports transactions; sequential best-effort otherwise (tests).
 */
async function emitAndMark(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
  connection: IntegrationConnection,
  eventType: IntegrationEventType | ScmEventType,
  subject: { kind: string; id: string; name?: string | null },
  payload: Record<string, unknown>,
  description: string,
): Promise<DeliveryOutcome> {
  const eventId = generateUuid();
  const build = (events: EventsRepository, repo: IntegrationsRepository) =>
    (async () => {
      const appended = await events.appendEventWithAudit({
        event: {
          id: eventId,
          type: eventType,
          version: 1,
          source: "integrations-worker",
          occurredAt: ctx.now(),
          actorType: "system",
          actorId: "integrations-worker",
          orgId: connection.orgId,
          subjectKind: subject.kind,
          subjectId: subject.id,
          subjectName: subject.name ?? null,
          requestId: inboundDeliveryPublicId(delivery.id),
          payload,
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description,
        },
      });
      if (!appended.ok) throw new Error("event_append_failed");
      const marked = await repo.markInboundDelivery(asUuid(delivery.id), {
        status: "emitted",
        orgId: asUuid(connection.orgId),
        connectionId: asUuid(connection.id),
        emittedEventId: asUuid(eventId),
        failureReason: null,
      });
      if (!marked.ok) throw new Error("delivery_mark_failed");
    })();

  try {
    const executor = ctx.executor as SqlExecutor & {
      transaction?: <T>(fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
    };
    if (typeof executor.transaction === "function") {
      await executor.transaction(async (tx) => {
        await build(createEventsRepository(tx), createIntegrationsRepository(tx));
      });
    } else {
      await build(ctx.events, ctx.repo);
    }
    return { kind: "emitted", eventType };
  } catch {
    return markRetryOrFail(ctx, delivery, "emit_failed");
  }
}

/** Provider lifecycle events: mutate connection/installation state + emit. */
async function processLifecycle(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
  connection: IntegrationConnection,
  installationId: number,
): Promise<DeliveryOutcome> {
  const action = delivery.action;
  const orgId = asUuid(connection.orgId);
  const connectionId = asUuid(connection.id);
  const installation = (delivery.payload.installation ?? {}) as Record<string, unknown>;
  const subject = { kind: "integration_connection", id: connection.id };

  if (delivery.eventType === "installation") {
    if (action === "deleted") {
      await ctx.repo.updateConnectionStatus(orgId, connectionId, "revoked");
      await ctx.repo.deleteInstallationToken(connectionId);
      return emitAndMark(
        ctx,
        delivery,
        connection,
        INTEGRATION_EVENT_TYPES.REVOKED,
        subject,
        {
          provider: "github",
          orgId: orgPublicId(connection.orgId),
          externalAccountLogin: connection.externalAccountLogin,
          origin: "provider_uninstall",
        },
        "GitHub App uninstalled on GitHub — connection revoked",
      );
    }
    if (action === "suspend") {
      await ctx.repo.updateConnectionStatus(orgId, connectionId, "suspended");
      return emitAndMark(
        ctx,
        delivery,
        connection,
        INTEGRATION_EVENT_TYPES.SUSPENDED,
        subject,
        { provider: "github", orgId: orgPublicId(connection.orgId) },
        "GitHub installation suspended",
      );
    }
    if (action === "unsuspend") {
      await ctx.repo.updateConnectionStatus(orgId, connectionId, "active");
      return emitAndMark(
        ctx,
        delivery,
        connection,
        INTEGRATION_EVENT_TYPES.REACTIVATED,
        subject,
        { provider: "github", orgId: orgPublicId(connection.orgId) },
        "GitHub installation unsuspended",
      );
    }
    if (action === "new_permissions_accepted") {
      await ctx.repo.upsertGithubInstallation({
        id: generateUuid(),
        connectionId,
        installationId,
        permissions: (installation.permissions as Record<string, unknown>) ?? null,
        events: Array.isArray(installation.events) ? installation.events : null,
        accountLogin: connection.externalAccountLogin,
        accountType: connection.externalAccountType,
      });
      return markSkipped(ctx, delivery, "permissions_updated", {
        orgId: connection.orgId,
        connectionId: connection.id,
      });
    }
    // "created" arrives after the setup callback already activated the
    // connection — nothing to do beyond attribution.
    return markSkipped(ctx, delivery, "lifecycle_noop", {
      orgId: connection.orgId,
      connectionId: connection.id,
    });
  }

  if (delivery.eventType === "installation_repositories") {
    await ctx.repo.upsertGithubInstallation({
      id: generateUuid(),
      connectionId,
      installationId,
      repositorySelection:
        typeof installation.repository_selection === "string"
          ? installation.repository_selection
          : null,
      accountLogin: connection.externalAccountLogin,
      accountType: connection.externalAccountType,
      permissions: (installation.permissions as Record<string, unknown>) ?? null,
      events: Array.isArray(installation.events) ? installation.events : null,
    });
    return emitAndMark(
      ctx,
      delivery,
      connection,
      INTEGRATION_EVENT_TYPES.REPO_SELECTION_CHANGED,
      subject,
      {
        provider: "github",
        orgId: orgPublicId(connection.orgId),
        repositorySelection: installation.repository_selection ?? null,
        action: action,
      },
      "GitHub repository selection changed",
    );
  }

  // github_app_authorization: a user revoked their OAuth grant — installs
  // are unaffected; the identity context owns user-level auth.
  return markSkipped(ctx, delivery, "user_authorization_event", {
    orgId: connection.orgId,
    connectionId: connection.id,
  });
}

/** Process a single inbox row end to end. Exported for the replay handler. */
export async function processDelivery(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
): Promise<DeliveryOutcome> {
  // Defensive: ingest never persists unverified rows, but the drain must not
  // trust that invariant blindly.
  if (!delivery.signatureOk) {
    return markSkipped(ctx, delivery, "signature_unverified");
  }

  const installationId = installationIdFromPayload(delivery.payload);
  if (installationId == null) {
    return markSkipped(ctx, delivery, "no_installation_reference");
  }

  const installation = await ctx.repo.getGithubInstallationByInstallationId(installationId);
  if (!installation.ok || installation.value.connectionId == null) {
    // Unsolicited/orphaned installation traffic: record the installation so
    // admin can see it, but never bind or emit (fail closed, design §4).
    if (!installation.ok) {
      await ctx.repo.upsertGithubInstallation({
        id: generateUuid(),
        connectionId: null,
        installationId,
      });
    }
    return markSkipped(ctx, delivery, "unattributed_installation");
  }

  const connection = await ctx.repo.getConnectionById(asUuid(installation.value.connectionId));
  if (!connection.ok) {
    return markSkipped(ctx, delivery, "connection_missing");
  }

  if (LIFECYCLE_EVENT_TYPES.has(delivery.eventType)) {
    return processLifecycle(ctx, delivery, connection.value, installationId);
  }

  if (connection.value.status === "revoked") {
    return markSkipped(ctx, delivery, "connection_revoked", {
      orgId: connection.value.orgId,
      connectionId: connection.value.id,
    });
  }

  const normalized = normalizeScmEvent(
    delivery.eventType,
    delivery.action,
    delivery.payload,
    orgPublicId(connection.value.orgId),
  );
  if (!normalized) {
    return markSkipped(ctx, delivery, "unsupported_event", {
      orgId: connection.value.orgId,
      connectionId: connection.value.id,
    });
  }

  // IG3 enrichment: a repo matching active links emits per linked project
  // with projectId + the environment resolved from the branch map; an
  // unlinked repo emits org-scoped only (design §6).
  const links = await ctx.repo.listActiveRepoLinksForRepo(
    asUuid(connection.value.orgId),
    normalized.repo.externalId,
  );
  const targets: Array<{ projectId: string | null; environment: string | null }> =
    links.ok && links.value.length > 0
      ? links.value.map((link) => ({
          projectId: link.projectId,
          environment: resolveEnvironment(link.branchEnvMap, normalized.payload),
        }))
      : [{ projectId: null, environment: null }];

  return emitScmEvents(ctx, delivery, connection.value, normalized, targets);
}

/** Branch the event refers to, for environment resolution. */
function eventBranch(payload: Record<string, unknown>): string | null {
  if (typeof payload.branch === "string" && payload.branch) return payload.branch;
  // Pull requests resolve against their TARGET branch.
  if (typeof payload.targetBranch === "string" && payload.targetBranch) return payload.targetBranch;
  return null;
}

function resolveEnvironment(
  branchEnvMap: Record<string, string>,
  payload: Record<string, unknown>,
): string | null {
  const branch = eventBranch(payload);
  if (!branch) return null;
  return branchEnvMap[branch] ?? null;
}

/**
 * Emit the normalized event once per target (org-scoped, or per linked
 * project) and mark the delivery `emitted` — all in one transaction when the
 * executor supports it.
 */
async function emitScmEvents(
  ctx: ProcessCtx,
  delivery: InboundDelivery,
  connection: IntegrationConnection,
  normalized: { type: ScmEventType; payload: Record<string, unknown>; repo: { externalId: string; fullName: string } },
  targets: Array<{ projectId: string | null; environment: string | null }>,
): Promise<DeliveryOutcome> {
  const firstEventId = generateUuid();
  const build = async (events: EventsRepository, repo: IntegrationsRepository): Promise<void> => {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;
      const appended = await events.appendEventWithAudit({
        event: {
          id: i === 0 ? firstEventId : generateUuid(),
          type: normalized.type,
          version: 1,
          source: "integrations-worker",
          occurredAt: ctx.now(),
          actorType: "system",
          actorId: "integrations-worker",
          orgId: connection.orgId,
          projectId: target.projectId,
          subjectKind: "repository",
          subjectId: normalized.repo.externalId,
          subjectName: normalized.repo.fullName,
          requestId: inboundDeliveryPublicId(delivery.id),
          payload: {
            ...normalized.payload,
            projectId: target.projectId ? projectPublicId(target.projectId) : null,
            environment: target.environment,
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `${normalized.type} on ${normalized.repo.fullName}`,
          projectId: target.projectId,
        },
      });
      if (!appended.ok) throw new Error("event_append_failed");
    }
    const marked = await repo.markInboundDelivery(asUuid(delivery.id), {
      status: "emitted",
      orgId: asUuid(connection.orgId),
      connectionId: asUuid(connection.id),
      emittedEventId: asUuid(firstEventId),
      failureReason: null,
    });
    if (!marked.ok) throw new Error("delivery_mark_failed");
  };

  try {
    const executor = ctx.executor as SqlExecutor & {
      transaction?: <T>(fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;
    };
    if (typeof executor.transaction === "function") {
      await executor.transaction(async (tx) => {
        await build(createEventsRepository(tx), createIntegrationsRepository(tx));
      });
    } else {
      await build(ctx.events, ctx.repo);
    }
    return { kind: "emitted", eventType: normalized.type };
  } catch {
    return markRetryOrFail(ctx, delivery, "emit_failed");
  }
}

/** One cron tick: claim due inbox rows oldest-first and process each. */
export async function drainInboundDeliveries(
  executor: SqlExecutor,
  _env: Env,
  opts?: { batchSize?: number; now?: () => Date },
): Promise<DrainSummary> {
  const ctx: ProcessCtx = {
    executor,
    repo: createIntegrationsRepository(executor),
    events: createEventsRepository(executor),
    now: opts?.now ?? (() => new Date()),
  };
  const summary: DrainSummary = { processed: 0, emitted: 0, skipped: 0, retried: 0, failed: 0 };

  const due = await ctx.repo.listDueInboundDeliveries(opts?.batchSize ?? DEFAULT_BATCH_SIZE);
  if (!due.ok) return summary;

  for (const delivery of due.value) {
    summary.processed += 1;
    try {
      const outcome = await processDelivery(ctx, delivery);
      if (outcome.kind === "emitted") summary.emitted += 1;
      else if (outcome.kind === "skipped") summary.skipped += 1;
      else if (outcome.kind === "retried") summary.retried += 1;
      else summary.failed += 1;
    } catch {
      const outcome = await markRetryOrFail(ctx, delivery, "processing_error");
      if (outcome.kind === "failed") summary.failed += 1;
      else summary.retried += 1;
    }
  }

  return summary;
}
