// `meterwise webhook deliveries <endpointId> [--limit=N] [--cursor=CURSOR] [--all]`
//   [--output=human|json] — Task 0120, milestone B5-webhook-delivery-history.
//
// The CLI leg of the per-endpoint webhook delivery-history observability
// surface. Symmetric to the Task 0120 console delivery-history panel and a
// pure SDK consumer of the locked `client.webhooks.listDeliveryAttemptsPage`
// shape (Task 0120 SDK addition).
//
// Pagination mirrors `audit list` (cross-reads.ts) exactly, which is the
// established cursor-pagination prior-art in this CLI:
//
//   - Default mode: one-shot fetch of a single page via
//     `listDeliveryAttemptsPage(orgId, endpointId, query)`. JSON output emits
//     `{ deliveryAttempts, next_cursor }`; human mode prints a compact table
//     (status / eventType / attempt / http / completedAt / id) with the next
//     cursor appended to the title when more pages remain.
//
//   - `--all` mode: drives the same page method in a loop, following the
//     server-issued cursor until it returns null. JSON mode emits one JSON
//     document per page (JSON Lines); human mode concatenates rows under a
//     single header. A seen-cursor guard aborts on a pagination loop.
//
// CRITICAL — cursor provenance: the webhooks-worker emits the continuation
// cursor as an opaque base64 token in `meta.cursor` (NOT the vestigial body
// `nextCursor`). The SDK's `listDeliveryAttemptsPage` already surfaces it as
// `page.nextCursor`. The cursor is opaque: it is forwarded verbatim and never
// constructed or parsed here.
//
// Org id is resolved through the persisted active-org context (no `--org`
// override — mirrors the rest of the webhook CLI surface via
// `resolveOrgId(ctx, /* allowOverride */ false)`). There is no network,
// header building, or auth handling in this module — all of that lives behind
// the SDK transport. The command is read-only and never sends an
// Idempotency-Key.
//
// Errors:
//   - missing positional `<endpointId>` → `UsageError`, exit 2.
//   - `--limit` non-positive-integer → `UsageError`, exit 2.
//   - `--all` together with `--cursor` → `UsageError`, exit 2.
//   - `--output=invalid` → `UsageError`, exit 2.
//   - SDK error (4xx/5xx) → propagated through the existing `formatCliError`
//     path; the response is never `.toString()`'d or interpolated.

import type { CommandContext, CommandResult } from "../router.js";
import type {
  PublicWebhookDeliveryAttempt,
  ListDeliveryAttemptsQuery,
} from "@saas/sdk";
import { UsageError } from "../errors.js";
import { resolveOrgId } from "./helpers.js";
import { formatOutput } from "../output/index.js";

// Defensive cap on the --all loop, mirroring `audit list` (1000 pages). At the
// server-max page size of 100 this bounds a single invocation to 100k rows —
// far beyond any realistic delivery-history scan, while still guaranteeing
// termination if the server ever misbehaves on the cursor contract.
const MAX_PAGES = 1000;

function parseLimit(flag: string | boolean | undefined): number | undefined {
  if (typeof flag !== "string" || flag.length === 0) return undefined;
  const n = Number.parseInt(flag, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new UsageError(`--limit must be a positive integer (got ${flag})`);
  }
  return n;
}

/**
 * Validate `--output=human|json`. The runner already coerces `output` into
 * `ctx.outputMode` (defaulting unknown values to `human`), but we gate the raw
 * flag here so the user gets a clean `UsageError` for typos like
 * `--output=yaml`. Mirrors the `webhook disable` gate with the
 * `webhook deliveries:` subcommand prefix.
 */
function assertOutputModeValid(ctx: CommandContext): void {
  const raw = ctx.flags["output"];
  if (raw === undefined || raw === false) return;
  if (raw === true) {
    throw new UsageError("webhook deliveries: --output requires human|json");
  }
  if (raw !== "human" && raw !== "json") {
    throw new UsageError(
      `webhook deliveries: --output must be human or json, got: ${raw}`,
    );
  }
}

function renderDeliveryRows(
  attempts: ReadonlyArray<PublicWebhookDeliveryAttempt>,
): {
  columns: ReadonlyArray<string>;
  rows: ReadonlyArray<Record<string, string>>;
} {
  return {
    columns: ["status", "eventType", "attempt", "http", "completedAt", "id"],
    rows: attempts.map((a) => ({
      status: a.status,
      eventType: a.eventType,
      attempt: String(a.attemptNumber),
      http: a.httpStatusCode === null ? "-" : String(a.httpStatusCode),
      completedAt: a.completedAt ?? "-",
      id: a.id,
    })),
  };
}

export async function webhookDeliveriesCommand(
  ctx: CommandContext,
): Promise<CommandResult> {
  assertOutputModeValid(ctx);

  const endpointId = ctx.args[0];
  if (endpointId === undefined || endpointId.length === 0) {
    throw new UsageError(
      "usage: meterwise webhook deliveries <endpointId> [--limit=N] [--cursor=CURSOR] [--all] [--output=human|json]",
    );
  }

  const limit = parseLimit(ctx.flags["limit"]);
  const cursorFlag = ctx.flags["cursor"];
  const cursor =
    typeof cursorFlag === "string" && cursorFlag.length > 0
      ? cursorFlag
      : undefined;
  const all = ctx.flags["all"] === true;

  if (all && cursor !== undefined) {
    throw new UsageError("--all and --cursor are mutually exclusive");
  }

  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const sdk = await ctx.sdk();

  // Build the SDK query. `cursor` is forwarded verbatim (opaque). In --all
  // mode we never pass the user's `cursor` (already rejected above) — the loop
  // supplies its own server-issued cursor each iteration.
  function buildQuery(forCursor: string | undefined): ListDeliveryAttemptsQuery {
    return {
      ...(limit !== undefined ? { limit } : {}),
      ...(forCursor !== undefined ? { cursor: forCursor } : {}),
    };
  }

  if (!all) {
    const page = await sdk.webhooks.listDeliveryAttemptsPage(
      orgId,
      endpointId,
      buildQuery(cursor),
    );
    if (ctx.outputMode === "json") {
      ctx.stdout(
        formatOutput({
          mode: "json",
          data: {
            deliveryAttempts: page.deliveryAttempts,
            next_cursor: page.nextCursor,
          },
        }),
      );
      return { exitCode: 0 };
    }
    const { columns, rows } = renderDeliveryRows(page.deliveryAttempts);
    ctx.stdout(
      formatOutput({
        mode: "human",
        columns,
        rows,
        title:
          `Delivery attempts for ${endpointId} in ${orgId}` +
          (page.nextCursor !== null
            ? ` (next cursor: ${page.nextCursor})`
            : ""),
      }),
    );
    return { exitCode: 0 };
  }

  // --all: follow the server-issued cursor until it returns null, batching
  // rows back into per-page JSON Lines (json) or one flat table (human).
  const allRows: Record<string, string>[] = [];
  let nextCursor: string | undefined = undefined;
  let columns: ReadonlyArray<string> = [];
  let iterations = 0;
  const seenCursors = new Set<string>();

  while (iterations < MAX_PAGES) {
    iterations += 1;
    const page = await sdk.webhooks.listDeliveryAttemptsPage(
      orgId,
      endpointId,
      buildQuery(nextCursor),
    );
    if (ctx.outputMode === "json") {
      ctx.stdout(
        formatOutput({
          mode: "json",
          data: {
            deliveryAttempts: page.deliveryAttempts,
            next_cursor: page.nextCursor,
          },
        }),
      );
    } else {
      const rendered = renderDeliveryRows(page.deliveryAttempts);
      columns = rendered.columns;
      for (const row of rendered.rows) allRows.push(row);
    }
    if (page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(
        `delivery-history pagination loop detected at cursor ${page.nextCursor}`,
      );
    }
    seenCursors.add(page.nextCursor);
    nextCursor = page.nextCursor;
  }

  if (ctx.outputMode === "human") {
    ctx.stdout(
      formatOutput({
        mode: "human",
        columns,
        rows: allRows,
        title: `All delivery attempts for ${endpointId} in ${orgId} (${allRows.length} rows)`,
      }),
    );
  }
  return { exitCode: 0 };
}
