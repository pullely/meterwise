import type { Env } from "../../../apps/identity-worker/src/env";
import { googleProvider } from "../../../apps/identity-worker/src/oauth/google";
import { listEnabledProviderInfos } from "../../../apps/identity-worker/src/oauth/providers";

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 400 });
}

describe("google provider", () => {
  afterEach(() => {
    // @ts-expect-error reset injected fetch
    delete globalThis.fetch;
  });

  it("builds an authorize URL with the OIDC params", () => {
    const url = new URL(
      googleProvider.buildAuthorizeUrl({
        clientId: "cid.apps.googleusercontent.com",
        redirectUri: "https://api.example.com/v1/auth/oauth/google/callback",
        state: "signed-state",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid.apps.googleusercontent.com");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.example.com/v1/auth/oauth/google/callback",
    );
  });

  it("exchanges the code with a form-urlencoded body and returns the access token", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), init };
      return jsonResponse({ access_token: "ya29.token", id_token: "x" });
    }) as unknown as typeof fetch;

    const token = await googleProvider.exchangeCode({
      clientId: "cid",
      clientSecret: "csecret",
      code: "auth-code",
      redirectUri: "https://api.example.com/v1/auth/oauth/google/callback",
    });

    expect(token).toBe("ya29.token");
    expect(captured!.url).toBe("https://oauth2.googleapis.com/token");
    expect(captured!.init.method).toBe("POST");
    const headers = new Headers(captured!.init.headers as HeadersInit);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(captured!.init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("client_secret")).toBe("csecret");
  });

  it("returns null when the token exchange fails", async () => {
    globalThis.fetch = (async () => jsonResponse({ error: "invalid_grant" }, false)) as unknown as typeof fetch;
    expect(
      await googleProvider.exchangeCode({
        clientId: "c",
        clientSecret: "s",
        code: "bad",
        redirectUri: "https://api.example.com/cb",
      }),
    ).toBeNull();
  });

  it("maps userinfo to an OAuthIdentity (sub as subject, verified boolean)", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        sub: "108273",
        email: "dev@example.com",
        email_verified: true,
        name: "Dev Example",
      })) as unknown as typeof fetch;

    const identity = await googleProvider.fetchIdentity("ya29.token");
    expect(identity).toEqual({
      subject: "108273",
      email: "dev@example.com",
      emailVerified: true,
      displayName: "Dev Example",
    });
  });

  it("treats a stringified email_verified as verified, and missing sub as failure", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ sub: "1", email: "a@b.com", email_verified: "true" })) as unknown as typeof fetch;
    expect((await googleProvider.fetchIdentity("t"))?.emailVerified).toBe(true);

    globalThis.fetch = (async () => jsonResponse({ email: "a@b.com" })) as unknown as typeof fetch;
    expect(await googleProvider.fetchIdentity("t")).toBeNull();
  });
});

describe("provider enablement", () => {
  const base: Env = {
    ENVIRONMENT: "stage",
    DEBUG_DELIVERY: "true",
    OAUTH_STATE_SECRET: "state-secret-0123456789abcdef",
    OAUTH_REDIRECT_BASE_URL: "https://api.example.com",
  };

  it("lists google only once its client id + secret are present", () => {
    expect(listEnabledProviderInfos(base).map((p) => p.id)).toEqual([]);

    const configured: Env = {
      ...base,
      GOOGLE_OAUTH_CLIENT_ID: "cid.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "gsecret",
    };
    expect(listEnabledProviderInfos(configured).map((p) => p.id)).toContain("google");
  });
});
