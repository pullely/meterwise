import {
  CONNECT_STATE_TTL_MS,
  generateStateNonce,
  hashStateNonce,
  signConnectState,
  verifyConnectState,
  type ConnectStatePayload,
} from "@integrations-worker/state";

const SECRET = "test-state-secret";
const NOW = 1_750_000_000_000;

function payload(overrides?: Partial<ConnectStatePayload>): ConnectStatePayload {
  return {
    n: "a".repeat(32),
    p: "github",
    c: "11111111-2222-3333-4444-555555555555",
    o: "99999999-8888-7777-6666-555555555555",
    exp: NOW + CONNECT_STATE_TTL_MS,
    ...overrides,
  };
}

describe("connect-flow signed state (tenancy keystone)", () => {
  it("round-trips a signed payload", async () => {
    const state = await signConnectState(payload(), SECRET);
    const verified = await verifyConnectState(state, SECRET, NOW);
    expect(verified).toEqual(payload());
  });

  it("rejects expired state", async () => {
    const state = await signConnectState(payload({ exp: NOW - 1 }), SECRET);
    expect(await verifyConnectState(state, SECRET, NOW)).toBeNull();
  });

  it("rejects state at exactly the expiry instant", async () => {
    const state = await signConnectState(payload({ exp: NOW }), SECRET);
    expect(await verifyConnectState(state, SECRET, NOW)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const state = await signConnectState(payload(), SECRET);
    const [body, sig] = state.split(".") as [string, string];
    const forged = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as Record<
      string,
      unknown
    >;
    forged.o = "00000000-0000-0000-0000-000000000000"; // point at another org
    const forgedB64 = btoa(JSON.stringify(forged))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(await verifyConnectState(`${forgedB64}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it("rejects a signature minted with a different secret", async () => {
    const state = await signConnectState(payload(), "other-secret");
    expect(await verifyConnectState(state, SECRET, NOW)).toBeNull();
  });

  it("rejects malformed input", async () => {
    expect(await verifyConnectState("", SECRET, NOW)).toBeNull();
    expect(await verifyConnectState("no-dot", SECRET, NOW)).toBeNull();
    expect(await verifyConnectState(".sigonly", SECRET, NOW)).toBeNull();
    expect(await verifyConnectState("!!!.???", SECRET, NOW)).toBeNull();
  });

  it("generates unique nonces and stable hashes", async () => {
    const a = generateStateNonce();
    const b = generateStateNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(await hashStateNonce(a)).toBe(await hashStateNonce(a));
    expect(await hashStateNonce(a)).not.toBe(await hashStateNonce(b));
    expect(await hashStateNonce(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
