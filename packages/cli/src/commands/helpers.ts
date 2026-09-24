// Shared CLI command helpers (Task 0111).
//
// This module exists to eliminate the inline duplication of org-id
// resolution and idempotency-key reading that grew across multiple
// command modules during the Task 0101–0110 write/rotate surface
// build-out. Both `writes.ts` (5× call sites across `org invite`,
// `project create`, `env create`, `api-key create`, `webhook create`)
// and `webhook-secrets-rotate.ts` (1× call site) had byte-equivalent
// copies of the `--idempotency-key` reader, plus near-equivalent
// org-id resolvers (the rotate variant was the no-override branch
// of the writes variant). The Task 0110 verifier flagged the
// duplication and recommended extracting a shared `cli-helpers`
// module before the next CLI write/rotate surface lands; this module
// is that extraction.
//
// Public surface is intentionally narrow: exactly two functions.
// `assertOutputModeValid` (currently inlined in
// `webhook-secrets-rotate.ts`) is deliberately NOT extracted here —
// it is single-call-site today and narrower in scope; defer until a
// second consumer appears.

import type { CommandContext } from "../router.js";
import { MissingOrgContextError } from "../errors.js";

/**
 * Resolve the org id for a write/rotate command. Order:
 *   1. Explicit `--org=ORG_ID` flag (only honoured when `allowOverride`
 *      is true — currently `org invite` is the sole consumer).
 *   2. Persisted `activeOrgId` from `~/.config/meterwise/config.json`.
 *
 * Throws `MissingOrgContextError` when neither is available. The CLI
 * never silently picks a "first" org from the listing — that would let
 * a user run a write against a different tenant than they expected.
 */
export async function resolveOrgId(
  ctx: CommandContext,
  allowOverride: boolean,
): Promise<string> {
  if (allowOverride) {
    const flag = ctx.flags["org"];
    if (typeof flag === "string" && flag.length > 0) return flag;
  }
  const cliCtx = await ctx.contextStore.load();
  const orgId = cliCtx.activeOrgId;
  if (orgId === undefined || orgId.length === 0) {
    throw new MissingOrgContextError();
  }
  return orgId;
}

/**
 * Pull `--idempotency-key=KEY` from flags. Returns `undefined` when the
 * user did not pass the flag — the SDK will then omit the
 * `Idempotency-Key` header. The CLI deliberately does not auto-generate
 * one (Stripe parity); tests assert the verbatim passthrough and the
 * no-header path.
 */
export function readIdempotencyKey(ctx: CommandContext): string | undefined {
  const v = ctx.flags["idempotency-key"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
