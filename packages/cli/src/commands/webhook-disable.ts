// `meterwise webhook disable <endpointId> [--reason=TEXT]` — Task 0115.
//
// Symmetric CLI surface to the Task 0113-era console disable-endpoint
// dialog. Closes the final B5 endpoint-CRUD CLI gap (disable), making
// CLI endpoint-CRUD symmetric with console end-to-end and matching the
// established webhook CLI cadence:
//   0103 (webhook create) → 0107 (verify / sign) → 0110 (secrets rotate)
//   → 0111 (cli helpers extraction) → 0114 (webhook enable)
//   → 0115 (this disable subcommand).
//
// The command is a pure SDK consumer of the locked
// `client.webhooks.disableEndpoint` shape. It resolves the active org,
// issues exactly one SDK call, prints the disabled endpoint's salient
// fields, and exits 0. There is no network, header building, or auth
// handling in this module — all of that lives behind the SDK transport.
//
// Org id is resolved through the persisted active-org context (no
// `--org` override — mirrors `webhook enable` / `webhook secrets rotate`
// semantics via `resolveOrgId(ctx, /* allowOverride */ false)`). The
// CLI never auto-mints an `Idempotency-Key`: `--idempotency-key=KEY` is
// forwarded verbatim when supplied, omitted when absent.
//
// Unlike enable, the disable contract carries an optional operator-
// supplied reason (`DisableWebhookEndpointRequest = { reason?: string }`).
// `--reason=TEXT` is forwarded verbatim into the request body when
// supplied; absent → body is `{}`. A bare boolean `--reason` (no value)
// is rejected with `UsageError`. An explicitly empty string is forwarded
// as-is; the worker decides what to do with it.
//
// The disable response carries no secret material — the human block is
// `status` / `disabledReason` / `disabledAt` / `updatedAt` (4 lines vs
// enable's 3, the only intentional human-block divergence from 0114).
//
// Output:
//   - human (default): a header line plus an indented key/value block
//     (status / disabledReason / disabledAt / updatedAt).
//   - json: the SDK response shape verbatim, single-line.
//
// Errors:
//   - missing positional `<endpointId>` → `UsageError`, exit 2.
//   - bare `--reason` (no value) → `UsageError`, exit 2.
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
// `webhook enable`: the persisted active-org context is the only
// source, no `--org` flag plumbing on disable.

/**
 * Validate `--output=human|json`. The runner already coerces `output`
 * into `ctx.outputMode` (defaulting unknown values to `human`), but we
 * gate the raw flag here so the user gets a clean `UsageError` for
 * typos like `--output=yaml` rather than a silently-wrong human-mode
 * render. Mirrors the `webhook enable` gate exactly, with the
 * `webhook disable:` subcommand prefix.
 */
function assertOutputModeValid(ctx: CommandContext): void {
  const raw = ctx.flags["output"];
  if (raw === undefined || raw === false) return;
  if (raw === true) {
    throw new UsageError("webhook disable: --output requires human|json");
  }
  if (raw !== "human" && raw !== "json") {
    throw new UsageError(
      `webhook disable: --output must be human or json, got: ${raw}`,
    );
  }
}

export async function webhookDisableCommand(
  ctx: CommandContext,
): Promise<CommandResult> {
  assertOutputModeValid(ctx);

  const endpointId = ctx.args[0];
  if (endpointId === undefined || endpointId.length === 0) {
    throw new UsageError(
      "usage: meterwise webhook disable <endpointId> [--reason=TEXT] [--idempotency-key=KEY] [--output=human|json]",
    );
  }

  // `--reason=TEXT` → body `{ reason }`; absent → body `{}`. A bare
  // boolean `--reason` (no value) is a usage error: forwarding the
  // literal `true` would either confuse the worker or be silently
  // coerced. An explicitly empty string is forwarded as-is — let the
  // worker decide whether to accept it.
  const rawReason = ctx.flags["reason"];
  let body: { reason?: string } = {};
  if (rawReason === true) {
    throw new UsageError("webhook disable: --reason requires a value");
  }
  if (typeof rawReason === "string") {
    body = { reason: rawReason };
  }

  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const idempotencyKey = readIdempotencyKey(ctx);

  const sdk = await ctx.sdk();
  const response = await sdk.webhooks.disableEndpoint(
    orgId,
    endpointId,
    body,
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );

  if (ctx.outputMode === "json") {
    ctx.stdout(JSON.stringify(response));
    return { exitCode: 0 };
  }

  // Human mode. Disable carries no secret material; the block surfaces
  // the four operator-relevant fields: status (now "disabled"), the
  // disabledReason worker-applied (operator-supplied or default),
  // disabledAt (newly populated), and the touched updatedAt. The
  // header reuses the worker-side audit phrasing for cross-surface
  // consistency with the console dialog.
  const endpoint = response.endpoint;
  ctx.stdout(`Webhook endpoint disabled: ${endpointId} in ${orgId}`);
  ctx.stdout("");
  ctx.stdout(`  status:           ${endpoint.status}`);
  ctx.stdout(`  disabledReason:   ${endpoint.disabledReason}`);
  ctx.stdout(`  disabledAt:       ${endpoint.disabledAt}`);
  ctx.stdout(`  updatedAt:        ${endpoint.updatedAt}`);

  return { exitCode: 0 };
}
