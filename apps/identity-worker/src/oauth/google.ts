// Google OAuth 2.0 / OpenID Connect provider adapter.
//
// Google is a confidential client (client_secret protects the code exchange);
// `state` (signed + cookie-bound, see state.ts/cookies.ts) provides CSRF
// defense. The stable subject is the OIDC `sub` claim (email can change; sub
// does not). Unlike GitHub, Google's token endpoint expects a
// form-urlencoded body and returns a verified-email boolean directly.

import type { OAuthIdentity, OAuthProvider } from "./providers.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const SCOPE = "openid email profile";

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

export const googleProvider: OAuthProvider = {
  id: "google",
  displayName: "Google",

  buildAuthorizeUrl({ clientId, redirectUri, state }) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("state", state);
    // We only need identity at sign-in time — no offline/refresh token.
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");
    return url.toString();
  },

  async exchangeCode({ clientId, clientSecret, code, redirectUri }) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: unknown };
    const token = data.access_token;
    return typeof token === "string" && token.length > 0 ? token : null;
  },

  async fetchIdentity(accessToken): Promise<OAuthIdentity | null> {
    const res = await fetch(USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!res.ok) return null;
    const info = (await res.json()) as GoogleUserInfo;
    if (typeof info.sub !== "string" || !info.sub) return null;

    const email = typeof info.email === "string" && info.email ? info.email : null;
    // OIDC returns a boolean; some surfaces stringify it — accept both.
    const emailVerified = info.email_verified === true || info.email_verified === "true";
    const displayName = typeof info.name === "string" && info.name.trim() ? info.name : null;

    return { subject: info.sub, email, emailVerified, displayName };
  },
};
