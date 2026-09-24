// Platform-side installation-token cache (design §3/§7): serves only the
// platform's OWN provider calls (repo listing, connection health). The token
// is stored as an AES-256-GCM envelope and re-minted when missing or within
// the expiry margin. Brokered tenant tokens (IG4) never touch this cache.

import type { Env } from "./env.js";
import type { IntegrationsRepository } from "@saas/db/integrations";
import { asUuid } from "@saas/db/ids";
import { createEncryptionAdapter } from "./encryption.js";
import {
  createInstallationToken,
  mintAppJwt,
  type FetchLike,
} from "./github-app.js";
import { generateUuid } from "./ids.js";

/** Don't serve a cached token with less than this much life left. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export async function getPlatformInstallationToken(
  env: Env,
  repo: IntegrationsRepository,
  connectionId: string,
  installationId: number,
  nowMs: number,
  fetchImpl?: FetchLike,
): Promise<string | null> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.SECRET_ENCRYPTION_KEY) {
    return null;
  }
  const encryption = await createEncryptionAdapter(env.SECRET_ENCRYPTION_KEY);
  if (!encryption) return null;

  const cached = await repo.getInstallationToken(asUuid(connectionId));
  if (cached.ok && cached.value.expiresAt.getTime() - nowMs > EXPIRY_MARGIN_MS) {
    try {
      const envelope = JSON.parse(cached.value.tokenCiphertext) as Parameters<
        typeof encryption.decrypt
      >[0];
      return await encryption.decrypt(envelope);
    } catch {
      // Fall through to a fresh mint on any envelope/key mismatch.
    }
  }

  const jwt = await mintAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, nowMs);
  if (!jwt) return null;
  const minted = await createInstallationToken(jwt, installationId, fetchImpl);
  if (!minted) return null;

  const envelope = await encryption.encrypt(minted.token);
  await repo.upsertInstallationToken({
    id: generateUuid(),
    connectionId: asUuid(connectionId),
    tokenCiphertext: JSON.stringify(envelope),
    permissions: minted.permissions,
    expiresAt: new Date(minted.expiresAt),
  });
  return minted.token;
}
