// CLI error helpers. Translate `MeterwiseError` subclasses (from
// `@saas/sdk/errors`) into actionable CLI messages with non-zero exit
// codes; surface request IDs.
//
// Exit-code map (loosely follows Stripe CLI / curl precedent):
//   0   — success
//   1   — generic / unexpected failure
//   2   — usage error (missing arg, unknown subcommand)
//   3   — auth missing / login required
//   4   — auth invalid / token rejected
//   5   — context missing (e.g. `org use` not run, command needs an org)
//   6   — server-side error surfaced via SDK

import { MeterwiseError, UnauthenticatedError } from "@saas/sdk";

import { formatErrorJson, type OutputMode } from "./output/index.js";

export class MissingAuthError extends Error {
  constructor() {
    super("not logged in (run `meterwise login`)");
    this.name = "MissingAuthError";
  }
}

export class MissingOrgContextError extends Error {
  constructor() {
    super("no active organization (run `meterwise org use <id>`)");
    this.name = "MissingOrgContextError";
  }
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface FormatErrorInput {
  readonly err: unknown;
  readonly mode: OutputMode;
}

export interface FormattedError {
  readonly exitCode: number;
  readonly message: string;
}

export function formatCliError({ err, mode }: FormatErrorInput): FormattedError {
  if (err instanceof MissingAuthError) {
    return formatPlain(3, "auth_required", err.message, mode);
  }
  if (err instanceof MissingOrgContextError) {
    return formatPlain(5, "org_context_missing", err.message, mode);
  }
  if (err instanceof UsageError) {
    return formatPlain(2, "usage", err.message, mode);
  }
  if (err instanceof UnauthenticatedError) {
    return formatSdk(4, err, "token rejected — run `meterwise login` to refresh", mode);
  }
  if (err instanceof MeterwiseError) {
    return formatSdk(6, err, err.message, mode);
  }
  if (err instanceof Error) {
    return formatPlain(1, "internal_error", err.message, mode);
  }
  return formatPlain(1, "internal_error", String(err), mode);
}

function formatPlain(
  exitCode: number,
  code: string,
  message: string,
  mode: OutputMode,
): FormattedError {
  if (mode === "json") {
    return { exitCode, message: formatErrorJson({ code, message }) };
  }
  return { exitCode, message: `error: ${message}` };
}

function formatSdk(
  exitCode: number,
  err: MeterwiseError,
  hint: string,
  mode: OutputMode,
): FormattedError {
  if (mode === "json") {
    return {
      exitCode,
      message: formatErrorJson({
        code: err.code,
        message: err.message,
        ...(err.requestId ? { requestId: err.requestId } : {}),
      }),
    };
  }
  const reqIdSuffix = err.requestId ? ` (request id: ${err.requestId})` : "";
  return { exitCode, message: `error: ${hint}${reqIdSuffix}` };
}
