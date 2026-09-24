// `meterwise security events [--limit=N] [--cursor=CURSOR] [--all]`
//   [--output=human|json] — Task 0122, milestone B7-security-events-surfaces.
//
// The CLI leg of the account security-events observability surface. Symmetric
// to the Task 0122 console security page and a pure SDK consumer of the
// `client.securityEvents.listPage` shape (Task 0122 SDK addition).
//
// Pagination mirrors `webhook deliveries` (webhook-deliveries.ts) / `audit
// list` (cross-reads.ts) exactly, which are the established cursor-pagination
// prior-art in this CLI:
//
//   - Default mode: one-shot fetch of a single page via `listPage(query)`.
//     JSON output emits `{ securityEvents, next_cursor }`; human mode prints a
//     compact table (eventType / outcome / occurredAt / ip / userAgent / id)
//     with the next cursor appended to the title when more pages remain.
//
//   - `--all` mode: drives the same page method in a loop, following the
//     server-issued cursor until it returns null. JSON mode emits one JSON
//     document per page (JSON Lines); human mode concatenates rows under a
//     single header. A seen-cursor guard aborts on a pagination loop.
//
// CRITICAL — actor scope: this surface is account/actor-scoped (backed by
// `apps/identity-worker` via the api-edge `auth-facade`), NOT org-scoped.
// There is NO `--org` flag and NO `resolveOrgId` call — the request is scoped
// entirely by the bearer credential's actor.
//
// CRITICAL — cursor provenance: the identity-worker emits the continuation
// cursor as an opaque token in `meta.cursor`. The SDK's `listPage` already
// surfaces it as `page.nextCursor`. The cursor is opaque: it is forwarded
// verbatim and never constructed or parsed here.
//
// There is no network, header building, or auth handling in this module — all
// of that lives behind the SDK transport. The command is read-only and never
// sends an Idempotency-Key.
//
// Errors:
//   - `--limit` non-positive-integer → `UsageError`, exit 2.
//   - `--all` together with `--cursor` → `UsageError`, exit 2.
//   - `--output=invalid` → `UsageError`, exit 2.
//   - SDK error (4xx/5xx) → propagated through the existing `formatCliError`
//     path; the response is never `.toString()`'d or interpolated.

import type { CommandContext, CommandResult } from "../router.js";
import type {
  PublicSecurityEvent,
  ListSecurityEventsQuery,
} from "@saas/sdk";
import { UsageError } from "../errors.js";
import { formatOutput } from "../output/index.js";

// Defensive cap on the --all loop, mirroring `webhook deliveries` / `audit
// list` (1000 pages). Bounds a single invocation while still guaranteeing
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
 * `--output=yaml`. Mirrors `webhook deliveries` with the `security events:`
 * subcommand prefix.
 */
function assertOutputModeValid(ctx: CommandContext): void {
  const raw = ctx.flags["output"];
  if (raw === undefined || raw === false) return;
  if (raw === true) {
    throw new UsageError("security events: --output requires human|json");
  }
  if (raw !== "human" && raw !== "json") {
    throw new UsageError(
      `security events: --output must be human or json, got: ${raw}`,
    );
  }
}

function renderSecurityRows(events: ReadonlyArray<PublicSecurityEvent>): {
  columns: ReadonlyArray<string>;
  rows: ReadonlyArray<Record<string, string>>;
} {
  return {
    columns: ["eventType", "outcome", "occurredAt", "ip", "userAgent", "id"],
    rows: events.map((e) => ({
      eventType: e.eventType,
      outcome: e.outcome,
      occurredAt: e.occurredAt,
      ip: e.ip ?? "-",
      userAgent: e.userAgent ?? "-",
      id: e.id,
    })),
  };
}

export async function securityEventsCommand(
  ctx: CommandContext,
): Promise<CommandResult> {
  assertOutputModeValid(ctx);

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

  const sdk = await ctx.sdk();

  // Build the SDK query. `cursor` is forwarded verbatim (opaque). In --all
  // mode we never pass the user's `cursor` (already rejected above) — the loop
  // supplies its own server-issued cursor each iteration.
  function buildQuery(forCursor: string | undefined): ListSecurityEventsQuery {
    return {
      ...(limit !== undefined ? { limit } : {}),
      ...(forCursor !== undefined ? { cursor: forCursor } : {}),
    };
  }

  if (!all) {
    const page = await sdk.securityEvents.listPage(buildQuery(cursor));
    if (ctx.outputMode === "json") {
      ctx.stdout(
        formatOutput({
          mode: "json",
          data: {
            securityEvents: page.securityEvents,
            next_cursor: page.nextCursor,
          },
        }),
      );
      return { exitCode: 0 };
    }
    const { columns, rows } = renderSecurityRows(page.securityEvents);
    ctx.stdout(
      formatOutput({
        mode: "human",
        columns,
        rows,
        title:
          "Security events" +
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
    const page = await sdk.securityEvents.listPage(buildQuery(nextCursor));
    if (ctx.outputMode === "json") {
      ctx.stdout(
        formatOutput({
          mode: "json",
          data: {
            securityEvents: page.securityEvents,
            next_cursor: page.nextCursor,
          },
        }),
      );
    } else {
      const rendered = renderSecurityRows(page.securityEvents);
      columns = rendered.columns;
      for (const row of rendered.rows) allRows.push(row);
    }
    if (page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(
        `security-events pagination loop detected at cursor ${page.nextCursor}`,
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
        title: `All security events (${allRows.length} rows)`,
      }),
    );
  }
  return { exitCode: 0 };
}
