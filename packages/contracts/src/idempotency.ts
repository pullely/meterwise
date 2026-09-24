// Idempotency-Key request-header contract.
//
// Patterned on Stripe's Idempotency-Key surface (https://stripe.com/docs/api/idempotent_requests):
// the value is opaque to the server, ASCII-printable, and capped at 255 characters.
// Callers that retry an unsafe (POST/PATCH/PUT/DELETE) request with the same key can
// — once durable replay lands in Task 0095 — trust that the second call will not
// double-create. This module exports only the parser and the header constant; the
// actual replay store is intentionally NOT in scope here.
//
// Validation rules (kept deliberately strict — Stripe-compatible):
//   - Must be a non-empty string after trimming surrounding whitespace.
//     A whitespace-only header is treated as malformed (not "missing").
//   - Length 1..255 characters (after trim).
//   - All code points must be ASCII printable (U+0020..U+007E). This rejects
//     control characters, CR/LF (header-injection vector), and any non-ASCII.
//
// Stable surface:
//   - `IDEMPOTENCY_KEY_HEADER` is the canonical, Stripe-spelled header name used in
//     error messages. Case-insensitive `Headers.get("idempotency-key")` lookup is fine.
//   - `parseIdempotencyKey(value)` returns a tagged result so callers can branch
//     without throwing. `null`/`undefined` => `{ ok: true, key: null }` (header absent;
//     caller decides whether the route requires a key).

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

// Reject control characters, DEL, and any non-ASCII. Allow the full ASCII printable range.
const ASCII_PRINTABLE_RE = /^[\x20-\x7e]+$/;

export type IdempotencyKeyParseResult =
  | { ok: true; key: string | null }
  | { ok: false; reason: string };

/**
 * Parse and validate an `Idempotency-Key` header value.
 *
 * - `null` / `undefined` input => `{ ok: true, key: null }` (header absent).
 * - Empty / whitespace-only string => `{ ok: false, reason: "empty" }`.
 * - Longer than 255 chars => `{ ok: false, reason: "too_long" }`.
 * - Contains control / non-ASCII chars => `{ ok: false, reason: "illegal_characters" }`.
 * - Otherwise => `{ ok: true, key: <trimmed> }`.
 *
 * The `reason` strings are stable identifiers — surface them in error envelopes
 * via the `details` field so callers can branch programmatically without parsing
 * human-readable messages.
 */
export function parseIdempotencyKey(
  value: string | null | undefined,
): IdempotencyKeyParseResult {
  if (value === null || value === undefined) {
    return { ok: true, key: null };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty" };
  }

  if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return { ok: false, reason: "too_long" };
  }

  if (!ASCII_PRINTABLE_RE.test(trimmed)) {
    return { ok: false, reason: "illegal_characters" };
  }

  return { ok: true, key: trimmed };
}

/**
 * Human-readable message for a parse failure, suitable for the `message` field of
 * the standard error envelope. Always references the canonical header spelling
 * (`Idempotency-Key`) regardless of the case the caller used in the request.
 */
export function describeIdempotencyKeyParseError(reason: string): string {
  switch (reason) {
    case "empty":
      return `${IDEMPOTENCY_KEY_HEADER} header must not be empty.`;
    case "too_long":
      return `${IDEMPOTENCY_KEY_HEADER} header must be ${IDEMPOTENCY_KEY_MAX_LENGTH} characters or fewer.`;
    case "illegal_characters":
      return `${IDEMPOTENCY_KEY_HEADER} header must contain only ASCII printable characters (U+0020..U+007E).`;
    default:
      return `${IDEMPOTENCY_KEY_HEADER} header is malformed.`;
  }
}
