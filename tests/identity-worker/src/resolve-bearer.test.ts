import { createFakeRepository } from "./helpers/fake-repository";
import { asUuid } from "@saas/db";
import crypto from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}
if (typeof globalThis.crypto.randomUUID !== "function") {
  (globalThis.crypto as unknown as { randomUUID: () => string }).randomUUID = () => crypto.randomUUID();
}

import { createAuthService } from "../../../apps/identity-worker/src/services/auth";
import { hashSha256 } from "../../../apps/identity-worker/src/crypto";

describe("resolveBearer", () => {
  const fixedNow = new Date("2026-01-15T10:00:00.000Z");

  async function loginAndGetToken(repo: ReturnType<typeof createFakeRepository>) {
    const auth = createAuthService({ repo, now: () => fixedNow });
    const start = await auth.startLogin("user@example.com");
    if ("error" in start) throw new Error("startLogin failed");
    const complete = await auth.completeLogin(start.challengeId, start.rawCode);
    if ("error" in complete) throw new Error("completeLogin failed");
    return { auth, token: complete.token };
  }

  async function seedApiKey(repo: ReturnType<typeof createFakeRepository>, opts?: {
    status?: string;
    expiresAt?: Date | null;
    revokedAt?: Date | null;
  }) {
    const spId = crypto.randomUUID();
    const orgId = asUuid(crypto.randomUUID());
    const createdBy = asUuid(crypto.randomUUID());
    const rawKey = "sps_key_" + crypto.randomBytes(32).toString("hex");
    const keyHash = await hashSha256(rawKey);

    await repo.createServicePrincipal({
      id: spId,
      orgId,
      projectId: asUuid("00000000-0000-0000-0000-0000000000aa"),
      displayName: "CI Bot",
      createdBy,
      createdAt: fixedNow,
    });

    const keyId = crypto.randomUUID();
    const key = {
      id: keyId,
      servicePrincipalId: spId,
      orgId,
      keyPrefix: rawKey.slice(0, 12),
      keyHash,
      label: "test-key",
      createdBy,
      createdAt: fixedNow,
    };
    await repo.createApiKey(key);

    // Apply overrides
    const stored = repo._apiKeys.get(keyId)!;
    if (opts?.status) stored.status = opts.status;
    if (opts?.expiresAt !== undefined) stored.expiresAt = opts.expiresAt;
    if (opts?.revokedAt !== undefined) stored.revokedAt = opts.revokedAt;

    return { rawKey, spId, orgId };
  }

  describe("session token path", () => {
    it("resolves a valid session token as user actor", async () => {
      const repo = createFakeRepository();
      const { auth, token } = await loginAndGetToken(repo);
      const result = await auth.resolveBearer(token);

      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.actorType).toBe("user");
      expect(result.actorId).toMatch(/^usr_[0-9a-f]{32}$/);
      expect(result.email).toBe("user@example.com");
      expect(result.session).toBeDefined();
      expect(result.user).toBeDefined();
    });

    it("returns error for invalid session token", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const result = await auth.resolveBearer("sps_ses_00000000000000000000000000000000.deadbeef");

      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("unauthenticated");
    });

    it("returns error for expired session token", async () => {
      const repo = createFakeRepository();
      let currentTime = fixedNow;
      const auth = createAuthService({ repo, now: () => currentTime });

      const start = await auth.startLogin("user@example.com");
      if ("error" in start) throw new Error("startLogin failed");
      const complete = await auth.completeLogin(start.challengeId, start.rawCode);
      if ("error" in complete) throw new Error("completeLogin failed");

      currentTime = new Date(fixedNow.getTime() + 31 * 24 * 60 * 60 * 1000);
      const result = await auth.resolveBearer(complete.token);
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("unauthenticated");
    });
  });

  describe("API key path", () => {
    it("resolves a valid API key as service_principal actor", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const { rawKey, spId, orgId } = await seedApiKey(repo);

      const result = await auth.resolveBearer(rawKey);
      expect("error" in result).toBe(false);
      if ("error" in result) return;

      expect(result.actorType).toBe("service_principal");
      expect(result.actorId).toBe(`sp_${spId.replace(/-/g, "")}`);
      expect(result.orgId).toBe(orgId);
      expect(result.projectId).toBe("00000000-0000-0000-0000-0000000000aa");
      expect(result.displayName).toBe("CI Bot");
      expect(result.session).toBeUndefined();
      expect(result.user).toBeUndefined();
    });

    it("returns error for unknown API key", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const result = await auth.resolveBearer("sps_key_unknown_random_token_value");

      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("unauthenticated");
      expect(result.message).toContain("Invalid bearer token");
    });

    it("returns error for inactive API key", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const { rawKey } = await seedApiKey(repo, { status: "inactive" });

      const result = await auth.resolveBearer(rawKey);
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("unauthenticated");
      expect(result.message).toContain("not active");
    });

    it("returns error for revoked API key", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const { rawKey } = await seedApiKey(repo, { revokedAt: new Date("2026-01-14T00:00:00Z") });

      const result = await auth.resolveBearer(rawKey);
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("unauthenticated");
      expect(result.message).toContain("revoked");
    });

    it("returns error for expired API key", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const { rawKey } = await seedApiKey(repo, { expiresAt: new Date("2026-01-14T00:00:00Z") });

      const result = await auth.resolveBearer(rawKey);
      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("unauthenticated");
      expect(result.message).toContain("expired");
    });

    it("allows API key with null expiresAt (no expiry)", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const { rawKey } = await seedApiKey(repo, { expiresAt: null });

      const result = await auth.resolveBearer(rawKey);
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.actorType).toBe("service_principal");
    });

    it("allows API key with future expiresAt", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const { rawKey } = await seedApiKey(repo, { expiresAt: new Date("2027-01-01T00:00:00Z") });

      const result = await auth.resolveBearer(rawKey);
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.actorType).toBe("service_principal");
    });
  });

  describe("edge cases", () => {
    it("returns error for completely invalid token (no prefix match)", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const result = await auth.resolveBearer("totally-random-garbage");

      expect("error" in result).toBe(true);
      if (!("error" in result)) return;
      expect(result.error).toBe("unauthenticated");
    });

    it("returns error for empty string token", async () => {
      const repo = createFakeRepository();
      const auth = createAuthService({ repo, now: () => fixedNow });
      const result = await auth.resolveBearer("");

      expect("error" in result).toBe(true);
    });
  });
});
