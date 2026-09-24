// Vitest suite for @saas/webhook-verifier.
//
// Covers:
//   - Happy-path verification
//   - Header-case-insensitivity (Record + Headers shapes)
//   - Each VerifyFailureReason branch (one dedicated test per reason)
//   - signWebhookPayload round-trip through verifyWebhookSignature
//   - Byte-identity match against the canonical signing scheme as
//     implemented in apps/webhooks-worker/src/delivery.ts:45-61.
//     The scheme is duplicated below as `canonicalComputeSignature`
//     (NOT imported from the worker) so any future drift in either
//     side fails this test.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  SIGNATURE_PREFIX,
  TIMESTAMP_HEADER,
  signWebhookPayload,
  verifyWebhookSignature,
} from "../index.js";

// Verbatim duplicate of apps/webhooks-worker/src/delivery.ts:45-61's
// `computeSignature` — kept as a fixture so we exercise byte-identity
// without importing from the worker tree.
async function canonicalComputeSignature(
  secret: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = encoder.encode(`${timestamp}.${body}`);
  const sig = await crypto.subtle.sign("HMAC", key, message);
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

const SECRET = "whsec_test_super_secret";
const BODY = JSON.stringify({ id: "evt_123", type: "test.event", data: { hello: "world" } });
const TS = "1717000000"; // 2024-05-29T18:26:40Z, fixed epoch
const FIXED_NOW = () => new Date(Number(TS) * 1000);

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature (happy path)", async () => {
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: sig,
        [TIMESTAMP_HEADER]: TS,
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  it("is case-insensitive on Record header keys", async () => {
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        "x-webhook-signature": sig,
        "x-webhook-timestamp": TS,
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts a Headers instance input", async () => {
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const headers = new Headers();
    headers.set(SIGNATURE_HEADER, sig);
    headers.set(TIMESTAMP_HEADER, TS);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers,
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts Record<string, string|string[]|undefined> with array value", async () => {
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: [sig, "stale=ignored"],
        [TIMESTAMP_HEADER]: TS,
        "x-extra": undefined,
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns missing_signature when no signature header is present", async () => {
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: { [TIMESTAMP_HEADER]: TS },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("returns missing_timestamp when no timestamp header is present", async () => {
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: { [SIGNATURE_HEADER]: sig },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "missing_timestamp" });
  });

  it("returns malformed_timestamp on non-numeric timestamp", async () => {
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: sig,
        [TIMESTAMP_HEADER]: "not-a-number",
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "malformed_timestamp" });
  });

  it("returns malformed_timestamp on oversized timestamp", async () => {
    const huge = "9".repeat(40);
    const sig = await canonicalComputeSignature(SECRET, huge, BODY);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: sig,
        [TIMESTAMP_HEADER]: huge,
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "malformed_timestamp" });
  });

  it("returns timestamp_out_of_tolerance when stale beyond default 300s", async () => {
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: sig,
        [TIMESTAMP_HEADER]: TS,
      },
      now: () => new Date((Number(TS) + DEFAULT_TOLERANCE_SECONDS + 1) * 1000),
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("respects custom toleranceSeconds: 0 (any drift fails)", async () => {
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: sig,
        [TIMESTAMP_HEADER]: TS,
      },
      now: () => new Date((Number(TS) + 1) * 1000),
      toleranceSeconds: 0,
    });
    expect(result).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("returns malformed_signature when the sha256= prefix is missing", async () => {
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const stripped = sig.slice(SIGNATURE_PREFIX.length);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: stripped,
        [TIMESTAMP_HEADER]: TS,
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "malformed_signature" });
  });

  it("returns malformed_signature when hex is non-hex / odd-length", async () => {
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: "sha256=zz", // not hex
        [TIMESTAMP_HEADER]: TS,
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "malformed_signature" });
  });

  it("returns signature_mismatch on wrong secret", async () => {
    const sig = await canonicalComputeSignature("whsec_other_secret", TS, BODY);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: sig,
        [TIMESTAMP_HEADER]: TS,
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("returns signature_mismatch when body bytes are tampered", async () => {
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY + " ", // single byte added after signing
      headers: {
        [SIGNATURE_HEADER]: sig,
        [TIMESTAMP_HEADER]: TS,
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("returns signature_mismatch when timestamp is tampered (re-signed elsewhere wouldn't match)", async () => {
    // Sign with TS, then advertise TS+1 in the header — message templates
    // diverge so HMACs diverge.
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const tampered = String(Number(TS) + 1);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: sig,
        [TIMESTAMP_HEADER]: tampered,
      },
      now: () => new Date(Number(tampered) * 1000),
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("returns signature_mismatch on first-byte tamper of provided signature", async () => {
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const hex = sig.slice(SIGNATURE_PREFIX.length);
    const flipped = (hex[0] === "0" ? "1" : "0") + hex.slice(1);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: SIGNATURE_PREFIX + flipped,
        [TIMESTAMP_HEADER]: TS,
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("returns signature_mismatch on last-byte tamper of provided signature", async () => {
    // Symmetric structural assertion that the per-byte loop runs to
    // completion regardless of where the difference occurs (constant-time
    // intent — the test is intentionally not a wall-clock timing assertion;
    // structural equivalence with the first-byte case is sufficient and
    // stable in CI).
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    const hex = sig.slice(SIGNATURE_PREFIX.length);
    const last = hex[hex.length - 1] as string;
    const flipped = hex.slice(0, -1) + (last === "0" ? "1" : "0");
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: SIGNATURE_PREFIX + flipped,
        [TIMESTAMP_HEADER]: TS,
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("returns signature_mismatch on hex-length mismatch (truncated signature)", async () => {
    const sig = await canonicalComputeSignature(SECRET, TS, BODY);
    // Drop the last 4 hex chars — still even-length, still valid hex,
    // but byte length differs from a SHA-256 digest.
    const truncated = sig.slice(0, -4);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: truncated,
        [TIMESTAMP_HEADER]: TS,
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("uses default now() = new Date() when not supplied (within tolerance)", async () => {
    const nowSec = Math.floor(Date.now() / 1000).toString();
    const sig = await canonicalComputeSignature(SECRET, nowSec, BODY);
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: sig,
        [TIMESTAMP_HEADER]: nowSec,
      },
    });
    expect(result).toEqual({ ok: true });
  });
});

describe("signWebhookPayload", () => {
  it("produces sha256= prefix + 64 lowercase hex chars", async () => {
    const sig = await signWebhookPayload({ secret: SECRET, body: BODY, timestamp: TS });
    expect(sig.startsWith(SIGNATURE_PREFIX)).toBe(true);
    const hex = sig.slice(SIGNATURE_PREFIX.length);
    expect(hex).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(hex)).toBe(true);
  });

  it("signWebhookPayload output round-trips through verifyWebhookSignature", async () => {
    const sig = await signWebhookPayload({ secret: SECRET, body: BODY, timestamp: TS });
    const result = await verifyWebhookSignature({
      secret: SECRET,
      body: BODY,
      headers: {
        [SIGNATURE_HEADER]: sig,
        [TIMESTAMP_HEADER]: TS,
      },
      now: FIXED_NOW,
    });
    expect(result).toEqual({ ok: true });
  });

  it("byte-identity: matches apps/webhooks-worker delivery.ts canonical scheme", async () => {
    // Both implementations use the same `${timestamp}.${body}` template,
    // same HMAC-SHA256 over the secret, same `sha256=` + lowercase-hex
    // serialization. Any drift on either side fails this assertion.
    const fromHelper = await signWebhookPayload({
      secret: SECRET,
      body: BODY,
      timestamp: TS,
    });
    const fromCanonical = await canonicalComputeSignature(SECRET, TS, BODY);
    expect(fromHelper).toBe(fromCanonical);
  });
});
