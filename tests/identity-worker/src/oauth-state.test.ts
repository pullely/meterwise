import crypto from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}

import {
  generateStateNonce,
  signState,
  verifyState,
} from "../../../apps/identity-worker/src/oauth/state";

const SECRET = "test-state-secret-0123456789";

describe("oauth state", () => {
  it("round-trips a valid payload", async () => {
    const payload = {
      n: "nonce123",
      p: "github",
      r: "http://localhost:3000/auth/callback",
      exp: Date.now() + 60_000,
    };
    const token = await signState(payload, SECRET);
    expect(token).toContain(".");
    const verified = await verifyState(token, SECRET, Date.now());
    expect(verified).toEqual(payload);
  });

  it("rejects a tampered payload", async () => {
    const token = await signState(
      { n: "n", p: "github", r: "http://localhost:3000", exp: Date.now() + 60_000 },
      SECRET,
    );
    const [payloadB64, sig] = token.split(".");
    const tampered = `${payloadB64}x.${sig}`;
    expect(await verifyState(tampered, SECRET, Date.now())).toBeNull();
  });

  it("rejects a signature made with a different secret", async () => {
    const token = await signState(
      { n: "n", p: "github", r: "http://localhost:3000", exp: Date.now() + 60_000 },
      SECRET,
    );
    expect(await verifyState(token, "a-totally-different-secret-9999", Date.now())).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signState(
      { n: "n", p: "github", r: "http://localhost:3000", exp: 1_000 },
      SECRET,
    );
    expect(await verifyState(token, SECRET, Date.now())).toBeNull();
  });

  it("rejects a malformed token", async () => {
    expect(await verifyState("not-a-token", SECRET, Date.now())).toBeNull();
    expect(await verifyState("", SECRET, Date.now())).toBeNull();
  });

  it("generateStateNonce returns 32 hex chars and is non-repeating", () => {
    const a = generateStateNonce();
    const b = generateStateNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(b).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
