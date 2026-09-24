// Typed error hierarchy for the Meterwise SDK.
//
// The api-edge error envelope is:
//   { error: { code: string, message: string, details: object, requestId?: string } }
// where `code` is one of `ERROR_CODES` from `@saas/contracts/errors`. Unknown
// codes (forward compatibility) fall back to the generic `MeterwiseError`
// base class with the raw envelope preserved.
//
// `RateLimitError` decodes the `Retry-After` and `X-RateLimit-{Limit,Remaining,
// Reset}-<scope>` headers Task 0097 (B3 second half) emits. Header decoding is
// defensive: missing headers yield `null`, never throw.

import { ERROR_CODES, type ErrorCode } from "@saas/contracts/errors";

/** Raw error envelope as it comes off the wire. */
export interface ErrorEnvelope {
  code: string;
  message: string;
  details: Record<string, unknown>;
  requestId?: string;
}

export interface MeterwiseErrorInit {
  envelope: ErrorEnvelope;
  status: number;
  requestId: string;
  /** Original Response. Useful for callers that want to read raw headers. */
  response?: Response;
}

/**
 * Base error type. Unknown error codes (forward-compat, e.g. a future
 * `quota_exceeded`) decode to this class — `instanceof MeterwiseError`
 * still matches.
 */
export class MeterwiseError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  readonly details: Record<string, unknown>;
  readonly envelope: ErrorEnvelope;
  /** Present only when the error was synthesised from a real Response. */
  readonly response: Response | undefined;

  constructor(init: MeterwiseErrorInit) {
    super(init.envelope.message);
    this.name = "MeterwiseError";
    this.code = init.envelope.code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.details = init.envelope.details;
    this.envelope = init.envelope;
    this.response = init.response;
  }
}

export class BadRequestError extends MeterwiseError {
  constructor(init: MeterwiseErrorInit) {
    super(init);
    this.name = "BadRequestError";
  }
}

export class UnauthenticatedError extends MeterwiseError {
  constructor(init: MeterwiseErrorInit) {
    super(init);
    this.name = "UnauthenticatedError";
  }
}

export class ForbiddenError extends MeterwiseError {
  constructor(init: MeterwiseErrorInit) {
    super(init);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends MeterwiseError {
  constructor(init: MeterwiseErrorInit) {
    super(init);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends MeterwiseError {
  constructor(init: MeterwiseErrorInit) {
    super(init);
    this.name = "ConflictError";
  }
}

export class ValidationError extends MeterwiseError {
  /** Field-level violations, when the server provides them. */
  readonly fields: Record<string, string[]>;

  constructor(init: MeterwiseErrorInit) {
    super(init);
    this.name = "ValidationError";
    const raw = init.envelope.details["fields"];
    this.fields = isFieldMap(raw) ? raw : {};
  }
}

export class PreconditionFailedError extends MeterwiseError {
  constructor(init: MeterwiseErrorInit) {
    super(init);
    this.name = "PreconditionFailedError";
  }
}

export class UnsupportedError extends MeterwiseError {
  constructor(init: MeterwiseErrorInit) {
    super(init);
    this.name = "UnsupportedError";
  }
}

export class InternalError extends MeterwiseError {
  constructor(init: MeterwiseErrorInit) {
    super(init);
    this.name = "InternalError";
  }
}

/** Per-scope rate-limit window (org or identity). */
export interface RateLimitWindow {
  scope: "org" | "identity";
  limit: number | null;
  remaining: number | null;
  /** UTC seconds since epoch when the bucket fully refills. */
  resetAt: number | null;
}

export interface RateLimitErrorInit extends MeterwiseErrorInit {
  retryAfterSeconds: number | null;
  /** Scope that tripped the limit (echoed from `details.scope`). */
  scope: "org" | "identity" | null;
  windows: RateLimitWindow[];
}

export class RateLimitError extends MeterwiseError {
  readonly retryAfterSeconds: number | null;
  readonly scope: "org" | "identity" | null;
  readonly windows: RateLimitWindow[];

  constructor(init: RateLimitErrorInit) {
    super(init);
    this.name = "RateLimitError";
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.scope = init.scope;
    this.windows = init.windows;
  }

  /** Convenience accessor for the org-scope window, when present. */
  get orgWindow(): RateLimitWindow | undefined {
    return this.windows.find((w) => w.scope === "org");
  }

  /** Convenience accessor for the identity-scope window, when present. */
  get identityWindow(): RateLimitWindow | undefined {
    return this.windows.find((w) => w.scope === "identity");
  }
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/**
 * Decode an HTTP `Response` into the appropriate `MeterwiseError` subclass.
 *
 * Forward-compatible: unknown error codes resolve to the base `MeterwiseError`.
 * Robust to non-JSON 5xx bodies (gateway HTML, empty body, etc.) — synthesises
 * a generic `InternalError` envelope in that case.
 */
export async function decodeError(
  response: Response,
  fallbackRequestId: string,
): Promise<MeterwiseError> {
  const envelope = await readErrorEnvelope(response, fallbackRequestId);
  const requestId = envelope.requestId ?? fallbackRequestId;
  const init: MeterwiseErrorInit = {
    envelope,
    status: response.status,
    requestId,
    response,
  };

  switch (envelope.code as ErrorCode) {
    case ERROR_CODES.BAD_REQUEST:
      return new BadRequestError(init);
    case ERROR_CODES.UNAUTHENTICATED:
      return new UnauthenticatedError(init);
    case ERROR_CODES.FORBIDDEN:
      return new ForbiddenError(init);
    case ERROR_CODES.NOT_FOUND:
      return new NotFoundError(init);
    case ERROR_CODES.CONFLICT:
      return new ConflictError(init);
    case ERROR_CODES.VALIDATION_FAILED:
      return new ValidationError(init);
    case ERROR_CODES.PRECONDITION_FAILED:
      return new PreconditionFailedError(init);
    case ERROR_CODES.UNSUPPORTED:
      return new UnsupportedError(init);
    case ERROR_CODES.INTERNAL_ERROR:
      return new InternalError(init);
    case ERROR_CODES.RATE_LIMITED:
      return decodeRateLimit(init, response);
    default:
      // Forward-compat: unknown codes still surface a typed error.
      return new MeterwiseError(init);
  }
}

function decodeRateLimit(
  init: MeterwiseErrorInit,
  response: Response,
): RateLimitError {
  const retryAfter = parseIntHeader(response.headers.get("retry-after"));
  const detailsScope = init.envelope.details["scope"];
  const scope =
    detailsScope === "org" || detailsScope === "identity"
      ? (detailsScope as "org" | "identity")
      : null;
  const detailsRetry = init.envelope.details["retryAfterSeconds"];
  const detailsRetryNum =
    typeof detailsRetry === "number" && Number.isFinite(detailsRetry)
      ? detailsRetry
      : null;

  const windows: RateLimitWindow[] = [];
  for (const candidate of ["org", "identity"] as const) {
    const limit = parseIntHeader(
      response.headers.get(`x-ratelimit-limit-${candidate}`),
    );
    const remaining = parseIntHeader(
      response.headers.get(`x-ratelimit-remaining-${candidate}`),
    );
    const resetAt = parseIntHeader(
      response.headers.get(`x-ratelimit-reset-${candidate}`),
    );
    if (limit !== null || remaining !== null || resetAt !== null) {
      windows.push({ scope: candidate, limit, remaining, resetAt });
    }
  }

  return new RateLimitError({
    ...init,
    retryAfterSeconds: retryAfter ?? detailsRetryNum,
    scope,
    windows,
  });
}

async function readErrorEnvelope(
  response: Response,
  fallbackRequestId: string,
): Promise<ErrorEnvelope> {
  let raw: unknown = null;
  try {
    raw = await response.clone().json();
  } catch {
    raw = null;
  }
  const errorField = isObject(raw) ? raw["error"] : null;
  if (isObject(errorField)) {
    const code = typeof errorField["code"] === "string" ? errorField["code"] : null;
    const message =
      typeof errorField["message"] === "string"
        ? errorField["message"]
        : `HTTP ${response.status}`;
    const details = isObject(errorField["details"]) ? errorField["details"] : {};
    const requestId =
      typeof errorField["requestId"] === "string"
        ? errorField["requestId"]
        : undefined;
    if (code) {
      return { code, message, details, ...(requestId ? { requestId } : {}) };
    }
  }

  // Non-JSON or non-conformant body. Map by HTTP status.
  return {
    code: defaultCodeForStatus(response.status),
    message: `HTTP ${response.status}`,
    details: {},
    requestId: fallbackRequestId,
  };
}

function defaultCodeForStatus(status: number): ErrorCode {
  if (status === 400) return ERROR_CODES.BAD_REQUEST;
  if (status === 401) return ERROR_CODES.UNAUTHENTICATED;
  if (status === 403) return ERROR_CODES.FORBIDDEN;
  if (status === 404) return ERROR_CODES.NOT_FOUND;
  if (status === 409) return ERROR_CODES.CONFLICT;
  if (status === 412) return ERROR_CODES.PRECONDITION_FAILED;
  if (status === 422) return ERROR_CODES.VALIDATION_FAILED;
  if (status === 429) return ERROR_CODES.RATE_LIMITED;
  if (status === 415 || status === 405) return ERROR_CODES.UNSUPPORTED;
  return ERROR_CODES.INTERNAL_ERROR;
}

function parseIntHeader(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFieldMap(value: unknown): value is Record<string, string[]> {
  if (!isObject(value)) return false;
  for (const v of Object.values(value)) {
    if (!Array.isArray(v)) return false;
    for (const entry of v) {
      if (typeof entry !== "string") return false;
    }
  }
  return true;
}
