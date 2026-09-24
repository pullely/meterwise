import type { FetchLike } from "../github-app.js";
import { deleteInstallation, fetchInstallation, mintAppJwt } from "../github-app.js";
import type {
  BuildInstallUrlInput,
  CompleteConnectInput,
  IntegrationProvider,
  ProviderConnectionFacts,
  ProviderCredentials,
} from "./types.js";

const INSTALL_BASE = "https://github.com/apps";

/** Constant-time hex compare (signature verification, R2). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export function createGithubProvider(
  credentials: ProviderCredentials,
  fetchImpl: FetchLike = fetch,
): IntegrationProvider {
  return {
    id: "github",
    displayName: "GitHub",

    buildInstallUrl({ state }: BuildInstallUrlInput): string {
      const url = new URL(`${INSTALL_BASE}/${credentials.appSlug}/installations/new`);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async completeConnect({
      installationId,
      nowMs,
    }: CompleteConnectInput): Promise<ProviderConnectionFacts | null> {
      const jwt = await mintAppJwt(credentials.appId, credentials.privateKeyPem, nowMs);
      if (!jwt) return null;
      return fetchInstallation(jwt, installationId, fetchImpl);
    },

    async revokeInstallation(installationId: number, nowMs: number): Promise<boolean> {
      const jwt = await mintAppJwt(credentials.appId, credentials.privateKeyPem, nowMs);
      if (!jwt) return false;
      return deleteInstallation(jwt, installationId, fetchImpl);
    },

    // GitHub signs the RAW request body: X-Hub-Signature-256 = "sha256=" +
    // HMAC-SHA256(webhook secret, body). Verify before any parse (IG2 wires
    // the ingress; the verifier lives on the seam from day one).
    async verifyInboundSignature(
      rawBody: ArrayBuffer,
      signatureHeader: string | null,
    ): Promise<boolean> {
      if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
      const provided = signatureHeader.slice("sha256=".length).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(provided)) return false;

      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(credentials.webhookSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = await crypto.subtle.sign("HMAC", key, rawBody);
      const bytes = new Uint8Array(sig);
      let expected = "";
      for (let i = 0; i < bytes.length; i++) expected += bytes[i]!.toString(16).padStart(2, "0");
      return timingSafeEqualHex(provided, expected);
    },
  };
}
