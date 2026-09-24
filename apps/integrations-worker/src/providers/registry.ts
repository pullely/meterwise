import type { Env } from "../env.js";
import type { FetchLike } from "../github-app.js";
import { createGithubProvider } from "./github.js";
import type { IntegrationProvider } from "./types.js";

export interface ConfiguredIntegrationProvider {
  provider: IntegrationProvider;
}

/**
 * Resolve a provider adapter from per-environment credentials. Null when the
 * provider id is unknown OR its credential set is incomplete (D1 not done for
 * this environment) — callers park the live path with a safe error.
 */
export function getConfiguredProvider(
  env: Env,
  providerId: string,
  fetchImpl?: FetchLike,
): ConfiguredIntegrationProvider | null {
  if (providerId !== "github") return null;

  const appId = env.GITHUB_APP_ID;
  const appSlug = env.GITHUB_APP_SLUG;
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY;
  const webhookSecret = env.GITHUB_APP_WEBHOOK_SECRET;
  if (!appId || !appSlug || !privateKeyPem || !webhookSecret) return null;

  return {
    provider: createGithubProvider({ appId, appSlug, privateKeyPem, webhookSecret }, fetchImpl),
  };
}

/** Provider ids the registry knows about (marketplace cards, validation). */
export const KNOWN_PROVIDER_IDS = ["github"] as const;
