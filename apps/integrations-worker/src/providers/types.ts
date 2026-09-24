// The provider seam (design §2): handlers, repo layer, console, SDK, and
// contracts are provider-generic; only the adapter and per-provider credential
// config know GitHub. IG7 proves pluggability with a dormant second adapter
// compiling against this interface.

import type { GithubInstallationFacts } from "../github-app.js";

export interface BuildInstallUrlInput {
  /** Signed single-use connect state to round-trip through the provider. */
  state: string;
}

export interface CompleteConnectInput {
  /** Provider-side installation identifier from the setup callback. */
  installationId: number;
  nowMs: number;
}

/** Verified provider-side facts for an installation (null = unverifiable). */
export type ProviderConnectionFacts = GithubInstallationFacts;

export interface IntegrationProvider {
  id: string;
  displayName: string;

  // ── Connect (IG1) ─────────────────────────────────────────
  buildInstallUrl(input: BuildInstallUrlInput): string;
  /**
   * Fetch + verify installation facts as the App. Returning null means the
   * installation could not be verified — callers fail closed.
   */
  completeConnect(input: CompleteConnectInput): Promise<ProviderConnectionFacts | null>;
  /** Best-effort provider-side uninstall on platform revoke. */
  revokeInstallation(installationId: number, nowMs: number): Promise<boolean>;

  // ── Inbound (IG2) ─────────────────────────────────────────
  verifyInboundSignature(rawBody: ArrayBuffer, signatureHeader: string | null): Promise<boolean>;

  // ── Act (IG4) — broker lands with the token milestone ─────
  // mintToken(...) is added in IG4; keeping the surface minimal until then
  // avoids a dead contract that tests can't exercise.
}

export interface ProviderCredentials {
  appId: string;
  appSlug: string;
  privateKeyPem: string;
  webhookSecret: string;
}
