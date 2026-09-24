// GitHub OAuth provider adapter.
//
// GitHub OAuth Apps are confidential clients: the `client_secret` is the
// primary protection during code exchange, and `state` (signed + cookie-bound,
// see state.ts/cookies.ts) provides CSRF defense. The stable subject is the
// numeric GitHub user id (login/email can change; the id does not).

import type { OAuthIdentity, OAuthProvider } from "./providers.js";

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_USER_URL = "https://api.github.com/user";
const API_EMAILS_URL = "https://api.github.com/user/emails";
const SCOPE = "read:user user:email";
const USER_AGENT = "meterwise-identity-worker";

interface GitHubUser {
  id?: number;
  login?: string;
  name?: string | null;
  email?: string | null;
}

interface GitHubEmail {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

export const githubProvider: OAuthProvider = {
  id: "github",
  displayName: "GitHub",

  buildAuthorizeUrl({ clientId, redirectUri, state }) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "true");
    return url.toString();
  },

  async exchangeCode({ clientId, clientSecret, code, redirectUri }) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: unknown };
    const token = data.access_token;
    return typeof token === "string" && token.length > 0 ? token : null;
  },

  async fetchIdentity(accessToken): Promise<OAuthIdentity | null> {
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
    };

    const userRes = await fetch(API_USER_URL, { headers });
    if (!userRes.ok) return null;
    const user = (await userRes.json()) as GitHubUser;
    if (typeof user.id !== "number") return null;

    const subject = String(user.id);
    const displayName =
      (typeof user.name === "string" && user.name.trim()) ||
      (typeof user.login === "string" ? user.login : null) ||
      null;

    // Prefer the verified primary email; fall back to any verified email.
    let email: string | null = null;
    let emailVerified = false;
    const emailsRes = await fetch(API_EMAILS_URL, { headers });
    if (emailsRes.ok) {
      const emails = (await emailsRes.json()) as GitHubEmail[];
      if (Array.isArray(emails)) {
        const primaryVerified = emails.find((e) => e?.primary && e?.verified && typeof e.email === "string");
        const anyVerified = emails.find((e) => e?.verified && typeof e.email === "string");
        const chosen = primaryVerified ?? anyVerified;
        if (chosen && typeof chosen.email === "string") {
          email = chosen.email;
          emailVerified = true;
        }
      }
    }
    // Last resort: the public profile email (unverified — will not link).
    if (!email && typeof user.email === "string" && user.email) {
      email = user.email;
      emailVerified = false;
    }

    return { subject, email, emailVerified, displayName };
  },
};
