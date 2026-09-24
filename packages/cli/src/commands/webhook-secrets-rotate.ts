// `meterwise webhook secrets rotate <endpointId>` — Task 0110.
//
// Symmetric CLI surface to the Task 0109 console reveal-once rotate UX.
// Closes the B5 secret-rotation arc:
//   0108 (backend dual-secret grace) → 0109 (console reveal-once modal)
//   → 0110 (this CLI subcommand).
//
// The command is a pure SDK consumer of the locked
// `client.webhooks.rotateSecret` shape. It calls the SDK, prints the
// reveal-once plaintext when present (exactly once), and exits 0. The
// plaintext returned by the API is never persisted, never logged,
// never interpolated into a wider object — it flows from the SDK
// response straight to a single `ctx.stdout(...)` call site.
//
// Subcommand path is the durable three-segment plural form
// `["webhook", "secrets", "rotate"]`. This leaves room for future
// `webhook secrets list/reveal/revoke` without a rename and matches the
// `client.webhooks.rotateSecret` SDK semantics.
//
// Org id is resolved through the persisted active-org context (no
// `--org` override — mirrors `webhook create` in `writes.ts`). The CLI
// never auto-mints an `Idempotency-Key`: `--idempotency-key=KEY` is
// forwarded verbatim when supplied, omitted when absent.
//
// Output:
//   - human (default): a header line, an indented key/value block (with
//     the secret line elided when the server did not return plaintext),
//     and a reveal-once warning.
//   - json: the SDK response shape verbatim, single-line. When the
//     server returned no plaintext the `secret` key is absent from the
//     emitted JSON (matches the optional contract shape — we do NOT
//     serialise `"secret": null`).
//
// Errors:
//   - missing positional `<endpointId>` → `UsageError`, exit 2.
//   - `--output=invalid` → `UsageError`, exit 2.
//   - SDK error (4xx/5xx) → propagated through the existing
//     `formatCliError` path; the secret cannot be present on an error
//     branch, but we never `.toString()` or interpolate the response
//     into any error path either — defence in depth.

import type { CommandContext, CommandResult } from "../router.js";
import { UsageError } from "../errors.js";
import { resolveOrgId, readIdempotencyKey } from "./helpers.js";

// Org-id resolution and `--idempotency-key=KEY` reading are imported
// from `./helpers.js` (Task 0111 extraction). Use the no-override
// variant — `resolveOrgId(ctx, /* allowOverride */ false)` — to mirror
// `webhook create` semantics: the persisted active-org context is the
// only source, no `--org` flag plumbing on rotate.

/**
 * Validate `--output=human|json`. The runner already coerces `output`
 * into `ctx.outputMode` (defaulting unknown values to `human`), but we
 * gate the raw flag here so the user gets a clean `UsageError` for
 * typos like `--output=yaml` rather than a silently-wrong human-mode
 * render.
 */
function assertOutputModeValid(ctx: CommandContext): void {
  const raw = ctx.flags["output"];
  if (raw === undefined || raw === false) return;
  if (raw === true) {
    throw new UsageError("webhook secrets rotate: --output requires human|json");
  }
  if (raw !== "human" && raw !== "json") {
    throw new UsageError(
      `webhook secrets rotate: --output must be human or json, got: ${raw}`,
    );
  }
}

export async function webhookSecretsRotateCommand(
  ctx: CommandContext,
): Promise<CommandResult> {
  assertOutputModeValid(ctx);

  const endpointId = ctx.args[0];
  if (endpointId === undefined || endpointId.length === 0) {
    throw new UsageError(
      "usage: meterwise webhook secrets rotate <endpointId> [--idempotency-key=KEY] [--output=human|json]",
    );
  }

  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const idempotencyKey = readIdempotencyKey(ctx);

  const sdk = await ctx.sdk();
  const response = await sdk.webhooks.rotateSecret(
    orgId,
    endpointId,
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );

  if (ctx.outputMode === "json") {
    // Single stdout write, full response. `JSON.stringify` drops
    // optional fields that are `undefined`, so an absent `secret` is
    // naturally omitted from the JSON envelope (matches the contract).
    ctx.stdout(JSON.stringify(response));
    return { exitCode: 0 };
  }

  // Human mode.
  ctx.stdout(`Webhook signing secret rotated for ${endpointId} in ${orgId}`);
  ctx.stdout("");

  // The reveal-once plaintext is read from the SDK response exactly
  // once (the destructure below) and written to stdout exactly once
  // (the `secret:` line a few lines down). It is not interpolated
  // into any other object, log line, or error path.
  const secretPlaintext = response.secret;
  const hasPlaintext = secretPlaintext !== undefined;

  if (hasPlaintext) {
    ctx.stdout(`  secret:           ${secretPlaintext}          \u2190 reveal-once, copy now`);
  }
  ctx.stdout(`  secretVersion:    ${response.endpoint.secretVersion}`);
  ctx.stdout(
    `  previousExpires:  ${response.previousSecretExpiresAt ?? "(none)"}`,
  );
  ctx.stdout(`  gracePeriod:      ${response.gracePeriodSeconds}s`);
  ctx.stdout("");

  if (hasPlaintext) {
    ctx.stdout(
      "\u26A0  This secret will not be shown again. Subscribers using the previous",
    );
    ctx.stdout(
      "   secret have until previousExpires to roll over via the",
    );
    ctx.stdout("   X-Webhook-Signature-Previous header.");
  } else {
    ctx.stdout(
      "\u26A0  Plaintext was not returned by the server (no encryption key",
    );
    ctx.stdout(
      "   configured). Subscribers must obtain the new secret out of band.",
    );
  }

  return { exitCode: 0 };
}
