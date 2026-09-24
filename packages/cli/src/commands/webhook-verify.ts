// `meterwise webhook verify` — local cryptographic verification of a
// Meterwise outbound webhook delivery (Task 0106).
//
// This command is a thin shell around `@saas/webhook-verifier` (Task 0105).
// It deliberately:
//   - does NOT call the api-edge, the SDK, or any network. It is pure
//     local crypto.
//   - does NOT require auth, an active org, or a context store. The
//     command is usable on a fresh install with no `meterwise login`.
//   - does NOT JSON-parse or `.trim()` the body. The verifier hashes the
//     bytes verbatim; any reshape would break valid signatures.
//
// Behaviour:
//   - Success → stdout `ok: true` (human) / `{"ok":true}` (json), exit 0.
//   - Verifier failure → stdout `ok: false\nreason: <code>` (human) /
//     `{"ok":false,"reason":"<code>"}` (json), exit 4. Verifier failure
//     is the command's NORMAL result; exit code carries the signal, no
//     stderr text is emitted.
//   - Argument-shape errors (missing flag, bad tolerance, unreadable
//     body file, both `--body` and STDIN supplied) throw `UsageError` →
//     exit 2 via `formatCliError`.

import { promises as fs } from "node:fs";

import { verifyWebhookSignature } from "@saas/webhook-verifier";

import type { CommandContext, CommandResult } from "../router.js";
import { UsageError } from "../errors.js";

const VERIFIER_FAILURE_EXIT = 4;

/**
 * Pull a string flag, throwing `UsageError` when missing or empty.
 * Centralised so the three required flags share one error shape.
 */
function readRequiredString(
  ctx: CommandContext,
  name: string,
): string {
  const v = ctx.flags[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new UsageError(`webhook verify: missing required flag --${name}`);
  }
  return v;
}

/**
 * Parse `--tolerance-seconds=N`. Returns `undefined` when the flag is
 * absent (the helper's default of 300 then applies). Throws `UsageError`
 * when present but not a non-negative integer.
 */
function readToleranceSeconds(
  ctx: CommandContext,
): number | undefined {
  const raw = ctx.flags["tolerance-seconds"];
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) {
    throw new UsageError(
      "webhook verify: --tolerance-seconds requires a non-negative integer value",
    );
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new UsageError(
      `webhook verify: --tolerance-seconds must be a non-negative integer, got: ${raw}`,
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new UsageError(
      `webhook verify: --tolerance-seconds must be a non-negative integer, got: ${raw}`,
    );
  }
  return n;
}

/**
 * Read the entire webhook body. Either:
 *   - `--body=PATH` was supplied → read the file's raw bytes.
 *   - STDIN is piped (non-TTY) → drain it to EOF.
 *   - Neither → throw `UsageError`.
 *
 * Both supplied (file flag AND piped STDIN) is also a `UsageError`.
 *
 * Bytes are decoded as UTF-8 because the helper accepts `body: string`
 * and re-encodes via `TextEncoder`. The CLI never `.trim()`s, JSON-parses,
 * or otherwise reshapes the bytes between read and helper call — webhook
 * payloads are JSON in practice and round-trip cleanly through UTF-8.
 */
async function readBody(
  ctx: CommandContext,
  stdin: StdinLike,
): Promise<string> {
  const bodyFlag = ctx.flags["body"];
  // `process.stdin.isTTY` is `true` only when stdin is attached to a real
  // terminal; for piped/redirected input (the webhook-verify use case)
  // Node leaves it `undefined`. Treat anything-not-true as "piped".
  const stdinPiped = stdin.isTTY !== true;

  if (typeof bodyFlag === "string" && bodyFlag.length > 0) {
    if (stdinPiped) {
      throw new UsageError(
        "webhook verify: --body=PATH and piped STDIN are mutually exclusive (pick one)",
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(bodyFlag);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new UsageError(
        `webhook verify: could not read --body=${bodyFlag}: ${reason}`,
      );
    }
    return new TextDecoder("utf-8").decode(bytes);
  }
  if (bodyFlag === true) {
    throw new UsageError("webhook verify: --body requires a file path");
  }

  if (stdinPiped) {
    return await drainStdin(stdin);
  }

  throw new UsageError(
    "webhook verify: provide either --body=PATH or pipe the webhook body on STDIN",
  );
}

/**
 * Read raw bytes from `stdin` to EOF, then UTF-8 decode. We assemble the
 * full byte buffer before decoding so multi-byte UTF-8 codepoints split
 * across chunks decode correctly.
 */
async function drainStdin(stdin: StdinLike): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stdin) {
    if (typeof chunk === "string") {
      chunks.push(new TextEncoder().encode(chunk));
    } else {
      // Buffer is a Uint8Array subclass — pass through.
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
 * Subset of `process.stdin` the command actually touches. Carved out as
 * an interface so tests can pass a synthetic async-iterable plus an
 * `isTTY` flag without poking globals.
 */
export interface StdinLike extends AsyncIterable<Uint8Array | string> {
  readonly isTTY?: boolean;
}

export interface WebhookVerifyOptions {
  /** Override `process.stdin` (tests). */
  readonly stdin?: StdinLike;
  /** Override `Date.now()` (tests). */
  readonly now?: () => Date;
}

export function makeWebhookVerifyCommand(
  options: WebhookVerifyOptions = {},
): (ctx: CommandContext) => Promise<CommandResult> {
  return async (ctx: CommandContext): Promise<CommandResult> => {
    const secret = readRequiredString(ctx, "secret");
    const signature = readRequiredString(ctx, "signature");
    const timestamp = readRequiredString(ctx, "timestamp");
    const tolerance = readToleranceSeconds(ctx);
    const stdin = options.stdin ?? (process.stdin as unknown as StdinLike);
    const body = await readBody(ctx, stdin);

    const verifyInput: Parameters<typeof verifyWebhookSignature>[0] = {
      secret,
      body,
      headers: {
        "X-Webhook-Signature": signature,
        "X-Webhook-Timestamp": timestamp,
      },
    };
    if (tolerance !== undefined) {
      verifyInput.toleranceSeconds = tolerance;
    }
    if (options.now !== undefined) {
      verifyInput.now = options.now;
    }

    const result = await verifyWebhookSignature(verifyInput);

    if (ctx.outputMode === "json") {
      if (result.ok) {
        ctx.stdout(`{"ok":true}`);
        return { exitCode: 0 };
      }
      ctx.stdout(`{"ok":false,"reason":"${result.reason}"}`);
      return { exitCode: VERIFIER_FAILURE_EXIT };
    }

    if (result.ok) {
      ctx.stdout("ok: true");
      ctx.stdout("reason: ");
      return { exitCode: 0 };
    }
    ctx.stdout("ok: false");
    ctx.stdout(`reason: ${result.reason}`);
    return { exitCode: VERIFIER_FAILURE_EXIT };
  };
}

/**
 * Default command handler used by the CLI runner. Tests use
 * `makeWebhookVerifyCommand({ stdin, now })` to inject controlled inputs.
 */
export const webhookVerifyCommand = makeWebhookVerifyCommand();
