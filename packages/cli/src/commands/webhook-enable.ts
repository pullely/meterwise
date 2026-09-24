// `meterwise webhook enable <endpointId>` — Task 0114.
//
// Symmetric CLI surface to the Task 0113 console "Re-enable" button +
// enable-endpoint dialog. Closes the B5 endpoint-CRUD CLI gap for the
// re-enable surface, matching the established webhook CLI cadence:
//   0103 (webhook create) → 0107 (verify / sign) → 0110 (secrets rotate)
//   → 0111 (cli helpers extraction) → 0114 (this re-enable subcommand).
//
// The command is a pure SDK consumer of the locked
// `client.webhooks.enableEndpoint` shape (Task 0113). It resolves the
// active org, issues exactly one SDK call, prints the re-enabled
// endpoint's salient fields, and exits 0. There is no network, header
// building, or auth handling in this module — all of that lives behind
// the SDK transport.
//
// Org id is resolved through the persisted active-org context (no
// `--org` override — mirrors `webhook secrets rotate` semantics via
// `resolveOrgId(ctx, /* allowOverride */ false)`). The CLI never
// auto-mints an `Idempotency-Key`: `--idempotency-key=KEY` is forwarded
// verbatim when supplied, omitted when absent.
//
// Unlike rotate, the enable response carries NO secret material — the
// `EnableWebhookEndpointResponse` is `{ endpoint }` only. The human
// block is therefore minimal (status / secretVersion / updatedAt) and
// there is no reveal-once warning.
//
// Output:
//   - human (default): a header line plus an indented key/value block
//     (status / secretVersion / updatedAt).
//   - json: the SDK response shape verbatim, single-line.
//
// Errors:
//   - missing positional `<endpointId>` → `UsageError`, exit 2.
//   - `--output=invalid` → `UsageError`, exit 2.
//   - SDK error (4xx/5xx) → propagated through the existing
//     `formatCliError` path. The response is never `.toString()`'d or
//     interpolated into any error branch.

import type { CommandContext, CommandResult } from "../router.js";
import { UsageError } from "../errors.js";
import { resolveOrgId, readIdempotencyKey } from "./helpers.js";

// Org-id resolution and `--idempotency-key=KEY` reading are imported
// from `./helpers.js` (Task 0111 extraction). Use the no-override
// variant — `resolveOrgId(ctx, /* allowOverride */ false)` — to mirror
// `webhook secrets rotate`: the persisted active-org context is the
// only source, no `--org` flag plumbing on enable.

/**
 * Validate `--output=human|json`. The runner already coerces `output`
 * into `ctx.outputMode` (defaulting unknown values to `human`), but we
 * gate the raw flag here so the user gets a clean `UsageError` for
 * typos like `--output=yaml` rather than a silently-wrong human-mode
 * render. Mirrors the `webhook secrets rotate` gate exactly, with the
 * `webhook enable:` subcommand prefix.
 */
function assertOutputModeValid(ctx: CommandContext): void {
  const raw = ctx.flags["output"];
  if (raw === undefined || raw === false) return;
  if (raw === true) {
    throw new UsageError("webhook enable: --output requires human|json");
  }
  if (raw !== "human" && raw !== "json") {
    throw new UsageError(
      `webhook enable: --output must be human or json, got: ${raw}`,
    );
  }
}

export async function webhookEnableCommand(
  ctx: CommandContext,
): Promise<CommandResult> {
  assertOutputModeValid(ctx);

  const endpointId = ctx.args[0];
  if (endpointId === undefined || endpointId.length === 0) {
    throw new UsageError(
      "usage: meterwise webhook enable <endpointId> [--idempotency-key=KEY] [--output=human|json]",
    );
  }

  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const idempotencyKey = readIdempotencyKey(ctx);

  const sdk = await ctx.sdk();
  const response = await sdk.webhooks.enableEndpoint(
    orgId,
    endpointId,
    {},
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );

  if (ctx.outputMode === "json") {
    ctx.stdout(JSON.stringify(response));
    return { exitCode: 0 };
  }

  // Human mode. Re-enable carries no secret material, so the block is
  // intentionally minimal: status / secretVersion / updatedAt. The
  // header reuses the worker-side audit phrasing ("Webhook endpoint
  // re-enabled") for cross-surface consistency with the console dialog.
  const endpoint = response.endpoint;
  ctx.stdout(`Webhook endpoint re-enabled: ${endpointId} in ${orgId}`);
  ctx.stdout("");
  ctx.stdout(`  status:           ${endpoint.status}`);
  ctx.stdout(`  secretVersion:    ${endpoint.secretVersion}`);
  ctx.stdout(`  updatedAt:        ${endpoint.updatedAt}`);

  return { exitCode: 0 };
}
