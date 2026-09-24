// Signed single-use connect-flow state — the tenancy keystone (design §4).
//
// GitHub redirects to one global setup URL with an `installation_id`; nothing
// in that redirect says which tenant initiated the install. The org binding is
// carried by THIS state: HMAC-signed payload in the install URL, with the
// nonce hash persisted on the pending connection row and consumed single-use
// at callback time. Same signing discipline as identity-worker's oauth/state.ts.

export interface ConnectStatePayload {
  /** Random nonce; its SHA-256 hex is persisted on the pending connection. */
  n: string;
  /** Provider id ("github"); guards against cross-provider state reuse. */
  p: string;
  /** Connection UUID the state was minted for (defense in depth). */
  c: string;
  /** Org UUID the state was minted for (defense in depth). */
  o: string;
  /** Expiry, epoch milliseconds (TTL ≤ 10 minutes). */
  exp: number;
}

export const CONNECT_STATE_TTL_MS = 10 * 60 * 1000;

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64urlToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64);
}

function stringToBase64url(s: string): string {
  return bytesToBase64url(new TextEncoder().encode(s));
}

/** Constant-time string compare to avoid leaking signature bytes via timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

async function hmacSign(payloadB64: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return bytesToBase64url(new Uint8Array(sig));
}

export async function signConnectState(payload: ConnectStatePayload, secret: string): Promise<string> {
  const payloadB64 = stringToBase64url(JSON.stringify(payload));
  const sig = await hmacSign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

export async function verifyConnectState(
  state: string,
  secret: string,
  nowMs: number,
): Promise<ConnectStatePayload | null> {
  const dot = state.indexOf(".");
  if (dot < 1) return null;
  const payloadB64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);

  const expected = await hmacSign(payloadB64, secret);
  if (!timingSafeEqual(sig, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64urlToString(payloadB64));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { n, p, c, o, exp } = parsed as Record<string, unknown>;
  if (
    typeof n !== "string" ||
    typeof p !== "string" ||
    typeof c !== "string" ||
    typeof o !== "string" ||
    typeof exp !== "number"
  ) {
    return null;
  }
  if (exp <= nowMs) return null;

  return { n, p, c, o, exp };
}

export function generateStateNonce(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) hex += buf[i]!.toString(16).padStart(2, "0");
  return hex;
}

/** SHA-256 hex of the nonce — what the pending connection row stores. */
export async function hashStateNonce(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}
