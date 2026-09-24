import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  describeIdempotencyKeyParseError,
  parseIdempotencyKey,
} from "@saas/contracts/idempotency";

describe("packages/contracts idempotency", () => {
  describe("IDEMPOTENCY_KEY_HEADER", () => {
    it("uses canonical Stripe-style spelling", () => {
      expect(IDEMPOTENCY_KEY_HEADER).toBe("Idempotency-Key");
    });
  });

  describe("parseIdempotencyKey", () => {
    it("returns ok with key=null when value is null", () => {
      expect(parseIdempotencyKey(null)).toEqual({ ok: true, key: null });
    });

    it("returns ok with key=null when value is undefined", () => {
      expect(parseIdempotencyKey(undefined)).toEqual({ ok: true, key: null });
    });

    it("accepts a typical UUID-shaped key", () => {
      const k = "550e8400-e29b-41d4-a716-446655440000";
      expect(parseIdempotencyKey(k)).toEqual({ ok: true, key: k });
    });

    it("accepts ASCII printable special chars", () => {
      const k = "client_retry:order#42/abc.xyz+~!@$%^&*()-_=";
      expect(parseIdempotencyKey(k)).toEqual({ ok: true, key: k });
    });

    it("trims surrounding whitespace and returns the trimmed key", () => {
      expect(parseIdempotencyKey("  abc  ")).toEqual({ ok: true, key: "abc" });
    });

    it("accepts a 255-character key (boundary)", () => {
      const k = "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH);
      expect(parseIdempotencyKey(k)).toEqual({ ok: true, key: k });
    });

    it("rejects empty string", () => {
      expect(parseIdempotencyKey("")).toEqual({ ok: false, reason: "empty" });
    });

    it("rejects whitespace-only string as empty", () => {
      expect(parseIdempotencyKey("   \t  ")).toEqual({ ok: false, reason: "empty" });
    });

    it("rejects 256-character key as too_long", () => {
      const k = "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1);
      expect(parseIdempotencyKey(k)).toEqual({ ok: false, reason: "too_long" });
    });

    it("rejects newline (header injection vector)", () => {
      expect(parseIdempotencyKey("abc\ndef")).toEqual({
        ok: false,
        reason: "illegal_characters",
      });
    });

    it("rejects carriage return", () => {
      expect(parseIdempotencyKey("abc\rdef")).toEqual({
        ok: false,
        reason: "illegal_characters",
      });
    });

    it("rejects null byte", () => {
      expect(parseIdempotencyKey("abc\u0000def")).toEqual({
        ok: false,
        reason: "illegal_characters",
      });
    });

    it("rejects non-ASCII characters", () => {
      expect(parseIdempotencyKey("café")).toEqual({
        ok: false,
        reason: "illegal_characters",
      });
      expect(parseIdempotencyKey("🔑")).toEqual({
        ok: false,
        reason: "illegal_characters",
      });
    });

    it("rejects DEL (0x7F) as illegal", () => {
      expect(parseIdempotencyKey("abc\u007fdef")).toEqual({
        ok: false,
        reason: "illegal_characters",
      });
    });
  });

  describe("describeIdempotencyKeyParseError", () => {
    it("references the canonical header in every message", () => {
      for (const reason of ["empty", "too_long", "illegal_characters", "wat"]) {
        expect(describeIdempotencyKeyParseError(reason)).toContain(
          IDEMPOTENCY_KEY_HEADER,
        );
      }
    });

    it("mentions the length cap for too_long", () => {
      const msg = describeIdempotencyKeyParseError("too_long");
      expect(msg).toContain(String(IDEMPOTENCY_KEY_MAX_LENGTH));
    });
  });
});
