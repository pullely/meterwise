import { createFakeRepository } from "./helpers/fake-repository";
import crypto from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}
if (typeof globalThis.crypto.randomUUID !== "function") {
  (globalThis.crypto as unknown as { randomUUID: () => string }).randomUUID = () => crypto.randomUUID();
}

import { createAuthService } from "../../../apps/identity-worker/src/services/auth";
import { parseSessionToken } from "../../../apps/identity-worker/src/ids";

const now = () => new Date("2026-02-01T00:00:00.000Z");

describe("loginWithOAuth", () => {
  it("creates a new user, auth identity, and session on first sign-in", async () => {
    const repo = createFakeRepository();
    const auth = createAuthService({ repo, now });

    const result = await auth.loginWithOAuth({
      provider: "github",
      subject: "12345",
      email: "Dev@Example.com",
      emailVerified: true,
      displayName: "Dev",
    });

    expect("error" in result).toBe(false);
    if ("error" in result) return;

    expect(repo._users.size).toBe(1);
    expect(repo._authIdentities.size).toBe(1);
    expect(repo._sessions.size).toBe(1);
    expect(result.user.email).toBe("Dev@Example.com");
    expect(parseSessionToken(result.token)).not.toBeNull();

    const identity = [...repo._authIdentities.values()][0]!;
    expect(identity.provider).toBe("github");
    expect(identity.subject).toBe("12345");
  });

  it("links to an existing user by verified email (no new user)", async () => {
    const repo = createFakeRepository();
    const auth = createAuthService({ repo, now });

    // Seed an existing email-OTP user.
    await auth.startLogin("dev@example.com");
    expect(repo._users.size).toBe(1);

    const result = await auth.loginWithOAuth({
      provider: "github",
      subject: "999",
      email: "dev@example.com",
      emailVerified: true,
      displayName: "Dev",
    });

    expect("error" in result).toBe(false);
    expect(repo._users.size).toBe(1); // linked, not created
    const providers = [...repo._authIdentities.values()].map((a) => a.provider);
    expect(providers).toContain("email");
    expect(providers).toContain("github");
  });

  it("refuses to link an UNVERIFIED provider email to an existing account", async () => {
    const repo = createFakeRepository();
    const auth = createAuthService({ repo, now });

    await auth.startLogin("dev@example.com");
    expect(repo._users.size).toBe(1);

    const result = await auth.loginWithOAuth({
      provider: "github",
      subject: "777",
      email: "dev@example.com",
      emailVerified: false,
      displayName: "Dev",
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toBe("email_unverified");
    expect(repo._users.size).toBe(1); // no second account, no link
    expect(repo._sessions.size).toBe(0);
  });

  it("returns the same user for a returning identity (stable subject)", async () => {
    const repo = createFakeRepository();
    const auth = createAuthService({ repo, now });

    const first = await auth.loginWithOAuth({
      provider: "github",
      subject: "42",
      email: "a@b.com",
      emailVerified: true,
      displayName: null,
    });
    const second = await auth.loginWithOAuth({
      provider: "github",
      subject: "42",
      email: "a@b.com",
      emailVerified: true,
      displayName: null,
    });

    expect("error" in first).toBe(false);
    expect("error" in second).toBe(false);
    if ("error" in first || "error" in second) return;

    expect(repo._users.size).toBe(1);
    expect(repo._authIdentities.size).toBe(1);
    expect(repo._sessions.size).toBe(2); // two logins → two sessions
    expect(first.user.id).toBe(second.user.id);
  });

  it("errors email_required when the provider supplies no email", async () => {
    const repo = createFakeRepository();
    const auth = createAuthService({ repo, now });

    const result = await auth.loginWithOAuth({
      provider: "github",
      subject: "1",
      email: null,
      emailVerified: false,
      displayName: null,
    });

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toBe("email_required");
  });

  it("never writes raw secrets into security-event metadata", async () => {
    const repo = createFakeRepository();
    const auth = createAuthService({ repo, now });

    await auth.loginWithOAuth({
      provider: "github",
      subject: "12345",
      email: "dev@example.com",
      emailVerified: true,
      displayName: "Dev",
    });

    const json = JSON.stringify(repo._securityEvents.map((e) => e.metadata));
    expect(/^sps_ses_/.test(json)).toBe(false);
    expect(/[0-9a-f]{64}/.test(json)).toBe(false);
  });
});
