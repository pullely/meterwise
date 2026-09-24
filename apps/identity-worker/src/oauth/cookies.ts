// Short-lived state cookie for the OAuth double-submit CSRF defense.
//
// The cookie holds the same `nonce` that is embedded in the signed `state`
// token. On callback we require the cookie nonce to equal the state nonce,
// which binds the OAuth completion to the browser that initiated it.
//
// Path is scoped to `/v1/auth/oauth` so the cookie is only sent on OAuth
// routes (never on ordinary API calls). `SameSite=Lax` still allows the cookie
// on the top-level GET navigation back from the provider.

export const STATE_COOKIE_NAME = "sp_oauth_state";

export interface CookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

export function buildStateCookie(nonce: string, opts: CookieOptions): string {
  const parts = [
    `${STATE_COOKIE_NAME}=${nonce}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/v1/auth/oauth",
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearStateCookie(secure: boolean): string {
  const parts = [`${STATE_COOKIE_NAME}=`, "HttpOnly", "SameSite=Lax", "Path=/v1/auth/oauth", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readStateCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const name = trimmed.slice(0, eq);
    if (name === STATE_COOKIE_NAME) {
      const value = trimmed.slice(eq + 1);
      return value || null;
    }
  }
  return null;
}
