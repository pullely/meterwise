/**
 * @saas/webhook-verifier — zero-dependency, WebCrypto-only HMAC-SHA256
 * signature verifier for Meterwise outbound webhook deliveries.
 *
 * Codifies the canonical signing scheme implemented in
 * `apps/webhooks-worker/src/delivery.ts` so external integrators
 * (and console-side replay tooling) don't reinvent it.
 *
 * Scheme:
 *   message   = `${timestamp}.${body}`
 *   signature = `sha256=` + lowercase-hex( HMAC-SHA256(secret, message) )
 *
 *   X-Webhook-Signature: sha256=<hex>
 *   X-Webhook-Timestamp: <unix-seconds>
 *   X-Webhook-ID:        <delivery uuid>
 *
 * Runs verbatim on Cloudflare Workers, Bun, modern Node, and browsers —
 * uses only `crypto.subtle.importKey` + `crypto.subtle.sign`.
 */

export const SIGNATURE_HEADER = "X-Webhook-Signature";
export const TIMESTAMP_HEADER = "X-Webhook-Timestamp";
export const WEBHOOK_ID_HEADER = "X-Webhook-ID";
export const SIGNATURE_PREFIX = "sha256=";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type VerifyFailureReason =
  | "missing_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "timestamp_out_of_tolerance"
  | "malformed_signature"
  | "signature_mismatch";

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailureReason };

export type HeadersInput =
  | Headers
  | Record<string, string | string[] | undefined>;

export interface VerifyWebhookSignatureInput {
  secret: string;
  body: string;
  headers: HeadersInput;
  now?: () => Date;
  toleranceSeconds?: number;
}

export interface SignWebhookPayloadInput {
  secret: string;
  body: string;
  timestamp: string;
}

// ── Header lookup (case-insensitive for both shapes) ──────────────────

function lookupHeader(headers: HeadersInput, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === lower) {
      const value = record[key];
      if (value === undefined) return undefined;
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

// ── Hex helpers ───────────────────────────────────────────────────────

const HEX_RE = /^[0-9a-f]+$/i;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!HEX_RE.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ── HMAC-SHA256 via WebCrypto ────────────────────────────────────────

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Constant-time equality over two equal-length byte arrays.
 * Loops the full length; never short-circuits on first mismatch.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Compute the canonical Meterwise webhook signature for a payload.
 * Returns the full `sha256=<hex>` header value.
 */
export async function signWebhookPayload(
  input: SignWebhookPayloadInput,
): Promise<string> {
  const hex = await hmacSha256Hex(input.secret, `${input.timestamp}.${input.body}`);
  return `${SIGNATURE_PREFIX}${hex}`;
}

/**
 * Verify the HMAC-SHA256 signature of a Meterwise webhook delivery.
 *
 * Returns a tagged result. On `ok: false`, `reason` enumerates the
 * exact failure mode for caller observability. Comparison is
 * constant-time (full-length XOR accumulator).
 */
export async function verifyWebhookSignature(
  input: VerifyWebhookSignatureInput,
): Promise<VerifyResult> {
  const sigHeader = lookupHeader(input.headers, SIGNATURE_HEADER);
  if (sigHeader === undefined || sigHeader === "") {
    return { ok: false, reason: "missing_signature" };
  }

  const tsHeader = lookupHeader(input.headers, TIMESTAMP_HEADER);
  if (tsHeader === undefined || tsHeader === "") {
    return { ok: false, reason: "missing_timestamp" };
  }

  // Timestamp must be a positive integer (unix seconds), bounded so wildly
  // large values can't bypass the tolerance check via overflow.
  if (!/^[0-9]+$/.test(tsHeader)) {
    return { ok: false, reason: "malformed_timestamp" };
  }
  const tsSeconds = Number(tsHeader);
  if (!Number.isFinite(tsSeconds) || tsSeconds > Number.MAX_SAFE_INTEGER / 1000) {
    return { ok: false, reason: "malformed_timestamp" };
  }

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = (input.now ?? (() => new Date()))();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSeconds - tsSeconds) > tolerance) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  if (!sigHeader.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: "malformed_signature" };
  }
  const providedHex = sigHeader.slice(SIGNATURE_PREFIX.length);
  const providedBytes = hexToBytes(providedHex);
  if (providedBytes === null) {
    return { ok: false, reason: "malformed_signature" };
  }

  const expectedHex = await hmacSha256Hex(input.secret, `${tsHeader}.${input.body}`);
  const expectedBytes = hexToBytes(expectedHex);
  // expectedBytes is always non-null (hmacSha256Hex emits 64 valid hex chars),
  // but the explicit guard keeps the compiler honest under
  // `noUncheckedIndexedAccess` and documents the invariant.
  if (expectedBytes === null) {
    return { ok: false, reason: "malformed_signature" };
  }

  if (providedBytes.length !== expectedBytes.length) {
    return { ok: false, reason: "signature_mismatch" };
  }

  if (!constantTimeEqual(providedBytes, expectedBytes)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return { ok: true };
}
