// `meterwise webhook deliveries replay <attemptId> [--output=human|json]`
//   — Task 0126, milestone B5-webhook-delivery-replay.
//
// The CLI leg of manual webhook delivery replay. Re-sends the SAME event to the
// SAME endpoint through the existing signing/delivery seam, recording a fresh
// delivery attempt in history. Pure SDK consumer of the locked
// `client.webhooks.replayDelivery(orgId, attemptId)` shape (Task 0126 SDK
// addition) — symmetric to the console "Redeliver" action.
//
// Unlike the read-only `webhook deliveries` listing, this is a MUTATING command
// (it triggers an outbound delivery), so the SDK transport attaches an
// idempotency key when one is supplied via `--idempotency-key=KEY`, mirroring
// `webhook enable` / `webhook disable`.
//
// Org id is resolved through the persisted active-org context (no `--org`
// override — mirrors the rest of the webhook CLI surface via
// `resolveOrgId(ctx, /* allowOverride */ false)`). There is no network, header
// building, or auth handling in this module — all of that lives behind the SDK
// transport.
//
// Output:
//   - human: a one-row summary of the NEW attempt (status / eventType /
//     attempt / http / id) so the operator can see the replay outcome inline.
//   - json: the raw `{ deliveryAttempt }` response object.
//
// Errors:
//   - missing positional `<attemptId>` → `UsageError`, exit 2.
//   - `--output=invalid` → `UsageError`, exit 2.
//   - SDK error (404 missing/cross-org, 5xx) → propagated through the existing
//     `formatCliError` path; the response is never `.toString()`'d.

import type { CommandContext, CommandResult } from "../router.js";
import type { PublicWebhookDeliveryAttempt } from "@saas/sdk";
import { UsageError } from "../errors.js";
import { resolveOrgId } from "./helpers.js";
import { formatOutput } from "../output/index.js";

/**
 * Validate `--output=human|json`. Mirrors the `webhook deliveries` gate with
 * the `webhook deliveries replay:` subcommand prefix.
 */
function assertOutputModeValid(ctx: CommandContext): void {
  const raw = ctx.flags["output"];
  if (raw === undefined || raw === false) return;
  if (raw === true) {
    throw new UsageError("webhook deliveries replay: --output requires human|json");
  }
  if (raw !== "human" && raw !== "json") {
    throw new UsageError(
      `webhook deliveries replay: --output must be human or json, got: ${raw}`,
    );
  }
}

function renderAttemptRow(attempt: PublicWebhookDeliveryAttempt): {
  columns: ReadonlyArray<string>;
  rows: ReadonlyArray<Record<string, string>>;
} {
  return {
    columns: ["status", "eventType", "attempt", "http", "id"],
    rows: [
      {
        status: attempt.status,
        eventType: attempt.eventType,
        attempt: String(attempt.attemptNumber),
        http: attempt.httpStatusCode === null ? "-" : String(attempt.httpStatusCode),
        id: attempt.id,
      },
    ],
  };
}

export async function webhookDeliveriesReplayCommand(
  ctx: CommandContext,
): Promise<CommandResult> {
  assertOutputModeValid(ctx);

  const attemptId = ctx.args[0];
  if (attemptId === undefined || attemptId.length === 0) {
    throw new UsageError(
      "usage: meterwise webhook deliveries replay <attemptId> [--output=human|json]",
    );
  }

  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const sdk = await ctx.sdk();

  const response = await sdk.webhooks.replayDelivery(orgId, attemptId);

  if (ctx.outputMode === "json") {
    ctx.stdout(
      formatOutput({
        mode: "json",
        data: { deliveryAttempt: response.deliveryAttempt },
      }),
    );
    return { exitCode: 0 };
  }

  const { columns, rows } = renderAttemptRow(response.deliveryAttempt);
  ctx.stdout(
    formatOutput({
      mode: "human",
      columns,
      rows,
      title: `Replayed delivery for attempt ${attemptId} → new attempt ${response.deliveryAttempt.id}`,
    }),
  );
  return { exitCode: 0 };
}
