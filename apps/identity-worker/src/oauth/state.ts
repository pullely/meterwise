// Stateless, signed OAuth `state` parameter.
//
// The `state` value round-trips through the OAuth provider, so it must be
// tamper-proof: we HMAC-sign a compact JSON payload with `OAUTH_STATE_SECRET`
// and verify the signature (and expiry) on callback. A random `nonce` is ALSO
// mirrored into an HttpOnly cookie (see `cookies.ts`) and re-checked on
// callback — binding the flow to the browser that started it. Without that
// double-submit, a signed-but-attacker-minted state would enable login CSRF
// (logging a victim into the attacker's account).

export interface OAuthStatePayload {
  /** Random nonce, mirrored into the state cookie for double-submit CSRF defense. */
  n: string;
  /** Provider id (e.g. "github"); guards against cross-provider state reuse. */
  p: string;
  /** Post-login return target (validated against the console-origin allowlist). */
  r: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stringToBase64url(s: string): string {
  return bytesToBase64url(new TextEncoder().encode(s));
}

function base64urlToString(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
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

/** Constant-time string compare to avoid leaking signature bytes via timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Generate a random nonce (hex) for the state/cookie double-submit pair. */
export function generateStateNonce(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) hex += buf[i]!.toString(16).padStart(2, "0");
  return hex;
}

export async function signState(payload: OAuthStatePayload, secret: string): Promise<string> {
  const payloadB64 = stringToBase64url(JSON.stringify(payload));
  const sig = await hmacSign(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a `state` token. Returns the decoded payload when the signature is
 * valid and the token has not expired, otherwise `null`.
 */
export async function verifyState(
  state: string,
  secret: string,
  nowMs: number,
): Promise<OAuthStatePayload | null> {
  const dot = state.indexOf(".");
  if (dot < 1) return null;
  const payloadB64 = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  if (!payloadB64 || !sig) return null;

  const expected = await hmacSign(payloadB64, secret);
  if (!timingSafeEqual(sig, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64urlToString(payloadB64));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const { n, p, r, exp } = parsed as Record<string, unknown>;
  if (typeof n !== "string" || typeof p !== "string" || typeof r !== "string" || typeof exp !== "number") {
    return null;
  }
  if (exp <= nowMs) return null;

  return { n, p, r, exp };
}
