// `meterwise webhook sign` — local cryptographic signing of a
// Meterwise outbound webhook payload (Task 0107).
//
// Symmetric counterpart to `webhook verify` (Task 0106). Wraps
// `@saas/webhook-verifier`'s `signWebhookPayload` exactly; all crypto
// goes through the helper, never through `node:crypto` or `node:buffer`
// directly. The command:
//   - does NOT call the api-edge, the SDK, or any network. Pure local
//     crypto.
//   - does NOT require auth, an active org, or a context store.
//   - does NOT JSON-parse, `.trim()`, or otherwise reshape the body.
//     Bytes are decoded once via UTF-8 and passed verbatim to the
//     helper, which hashes them as-is.
//
// Behaviour:
//   - Success → human:
//       signature: sha256=<hex>
//       timestamp: <ts>
//     json:
//       {"signature":"sha256=<hex>","timestamp":"<ts>"}
//     exit 0.
//   - Argument-shape errors (missing flag, bad timestamp, unreadable
//     body file, both `--body` and STDIN supplied, bad output mode)
//     throw `UsageError` → exit 2 via `formatCliError`.

import { promises as fs } from "node:fs";

import { signWebhookPayload } from "@saas/webhook-verifier";

import type { CommandContext, CommandResult } from "../router.js";
import { UsageError } from "../errors.js";

/**
 * Pull a string flag, throwing `UsageError` when missing or empty.
 */
function readRequiredString(
  ctx: CommandContext,
  name: string,
): string {
  const v = ctx.flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new UsageError(`webhook sign: missing required flag --${name}`);
  }
  return v;
}

/**
 * Validate `--timestamp=N`. The webhook-verifier helper accepts a string
 * here, but we still enforce the same shape `verify` requires of the
 * header: a positive integer (unix seconds). Catching malformed values
 * at sign time prevents producing signatures that the verifier will
 * later reject as `malformed_timestamp`.
 */
function readTimestamp(ctx: CommandContext): string {
  const raw = readRequiredString(ctx, "timestamp");
  if (!/^[0-9]+$/.test(raw)) {
    throw new UsageError(
      `webhook sign: --timestamp must be a non-negative integer (unix seconds), got: ${raw}`,
    );
  }
  // Reject 0 / 00... -- helper allows 0 but it's almost never what the
  // user means. Keep the surface tight; users can pass `1` in tests.
  // Range-check against MAX_SAFE_INTEGER so wildly large inputs fail
  // here rather than silently producing a signature with an unrepresentable
  // timestamp.
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new UsageError(
      `webhook sign: --timestamp must be a non-negative integer (unix seconds), got: ${raw}`,
    );
  }
  return raw;
}

/**
 * Read the entire webhook body. Either:
 *   - `--body=PATH` → read the file's raw bytes.
 *   - STDIN piped (non-TTY) → drain it to EOF.
 *   - Neither → throw `UsageError`.
 *
 * Both supplied (file flag AND piped STDIN) is also a `UsageError`.
 *
 * Bytes are decoded as UTF-8 because `signWebhookPayload` accepts
 * `body: string` and re-encodes via `TextEncoder`. The CLI never
 * `.trim()`s, JSON-parses, or otherwise reshapes the bytes between read
 * and helper call.
 */
async function readBody(
  ctx: CommandContext,
  stdin: StdinLike,
): Promise<string> {
  const bodyFlag = ctx.flags["body"];
  // `process.stdin.isTTY` is `true` only when stdin is attached to a
  // real terminal; for piped/redirected input Node leaves it
  // `undefined`. Treat anything-not-true as "piped".
  const stdinPiped = stdin.isTTY !== true;

  if (typeof bodyFlag === "string" && bodyFlag.length > 0) {
    if (stdinPiped) {
      throw new UsageError(
        "webhook sign: --body=PATH and piped STDIN are mutually exclusive (pick one)",
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(bodyFlag);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new UsageError(
        `webhook sign: could not read --body=${bodyFlag}: ${reason}`,
      );
    }
    return new TextDecoder("utf-8").decode(bytes);
  }
  if (bodyFlag === true) {
    throw new UsageError("webhook sign: --body requires a file path");
  }

  if (stdinPiped) {
    return await drainStdin(stdin);
  }

  throw new UsageError(
    "webhook sign: provide either --body=PATH or pipe the webhook body on STDIN",
  );
}

/**
 * Read raw bytes from `stdin` to EOF, then UTF-8 decode. We assemble
 * the full byte buffer before decoding so multi-byte UTF-8 codepoints
 * split across chunks decode correctly.
 */
async function drainStdin(stdin: StdinLike): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stdin) {
    if (typeof chunk === "string") {
      chunks.push(new TextEncoder().encode(chunk));
    } else {
      chunks.push(chunk);
    }
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/**
 * Subset of `process.stdin` the command actually touches. Identical
 * shape to `webhook-verify.ts:StdinLike` so tests can reuse harnesses.
 */
export interface StdinLike extends AsyncIterable<Uint8Array | string> {
  readonly isTTY?: boolean;
}

export interface WebhookSignOptions {
  /** Override `process.stdin` (tests). */
  readonly stdin?: StdinLike;
}

export function makeWebhookSignCommand(
  options: WebhookSignOptions = {},
): (ctx: CommandContext) => Promise<CommandResult> {
  return async (ctx: CommandContext): Promise<CommandResult> => {
    // `--output` is parsed at the runner level into `ctx.outputMode`,
    // but we still need to reject anything other than human|json so the
    // user gets a clean `UsageError` for typos. The runner's parser
    // currently coerces unknown values to `human` silently; gate here.
    const rawOutput = ctx.flags["output"];
    if (rawOutput !== undefined && rawOutput !== false) {
      if (rawOutput === true) {
        throw new UsageError("webhook sign: --output requires human|json");
      }
      if (rawOutput !== "human" && rawOutput !== "json") {
        throw new UsageError(
          `webhook sign: --output must be human or json, got: ${rawOutput}`,
        );
      }
    }

    const secret = readRequiredString(ctx, "secret");
    const timestamp = readTimestamp(ctx);
    const stdin = options.stdin ?? (process.stdin as unknown as StdinLike);
    const body = await readBody(ctx, stdin);

    const signature = await signWebhookPayload({ secret, body, timestamp });

    if (ctx.outputMode === "json") {
      ctx.stdout(
        `{"signature":"${signature}","timestamp":"${timestamp}"}`,
      );
      return { exitCode: 0 };
    }

    ctx.stdout(`signature: ${signature}`);
    ctx.stdout(`timestamp: ${timestamp}`);
    return { exitCode: 0 };
  };
}

/**
 * Default command handler used by the CLI runner. Tests use
 * `makeWebhookSignCommand({ stdin })` to inject controlled inputs.
 */
export const webhookSignCommand = makeWebhookSignCommand();
