import { createFakeRepository } from "./helpers/fake-repository";
import crypto from "node:crypto";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}
if (typeof globalThis.crypto.randomUUID !== "function") {
  (globalThis.crypto as unknown as { randomUUID: () => string }).randomUUID = () => crypto.randomUUID();
}

import type { Env } from "../../../apps/identity-worker/src/env";
import { handleOAuthStart } from "../../../apps/identity-worker/src/handlers/oauth-start";
import { handleOAuthCallback } from "../../../apps/identity-worker/src/handlers/oauth-callback";
import { handleOAuthProviders } from "../../../apps/identity-worker/src/handlers/oauth-providers";
import type { OAuthProvider } from "../../../apps/identity-worker/src/oauth/providers";

const ENV: Env = {
  ENVIRONMENT: "local",
  DEBUG_DELIVERY: "true",
  GITHUB_OAUTH_CLIENT_ID: "client-abc",
  GITHUB_OAUTH_CLIENT_SECRET: "secret-xyz",
  OAUTH_STATE_SECRET: "state-secret-0123456789abcdef",
  OAUTH_REDIRECT_BASE_URL: "http://localhost:8787",
  OAUTH_ALLOWED_CONSOLE_ORIGINS: "http://localhost:3000",
};

const RETURN_TO = "http://localhost:3000/auth/callback";

function startRequest(returnTo?: string): Request {
  const url = new URL("http://localhost:8787/v1/auth/oauth/github/start");
  if (returnTo !== undefined) url.searchParams.set("return_to", returnTo);
  return new Request(url.toString(), { method: "GET" });
}

function fakeProvider(identity: {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}): OAuthProvider {
  return {
    id: "github",
    displayName: "GitHub",
    buildAuthorizeUrl: () => "",
    exchangeCode: async () => "access-token",
    fetchIdentity: async () => identity,
  };
}

describe("oauth providers handler", () => {
  it("lists github when fully configured", async () => {
    const res = handleOAuthProviders(ENV, "req_1");
    const body = (await res.json()) as { data: { providers: { id: string }[] } };
    expect(body.data.providers.map((p) => p.id)).toEqual(["github"]);
  });

  it("lists nothing when the state secret is missing", async () => {
    const res = handleOAuthProviders({ ...ENV, OAUTH_STATE_SECRET: "" }, "req_1");
    const body = (await res.json()) as { data: { providers: unknown[] } };
    expect(body.data.providers).toEqual([]);
  });
});

describe("oauth start handler", () => {
  it("302s to GitHub with a state param and sets the state cookie", async () => {
    const res = await handleOAuthStart(startRequest(RETURN_TO), ENV, "req_1");
    expect(res.status).toBe(302);

    const location = res.headers.get("location")!;
    expect(location).toContain("https://github.com/login/oauth/authorize");
    const authorize = new URL(location);
    expect(authorize.searchParams.get("client_id")).toBe("client-abc");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "http://localhost:8787/v1/auth/oauth/github/callback",
    );
    expect(authorize.searchParams.get("state")).toBeTruthy();

    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/sp_oauth_state=[0-9a-f]+/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("422s when return_to is missing", async () => {
    const res = await handleOAuthStart(startRequest(), ENV, "req_1");
    expect(res.status).toBe(422);
  });

  it("422s when return_to is not an allow-listed origin", async () => {
    const res = await handleOAuthStart(startRequest("https://evil.example.com/callback"), ENV, "req_1");
    expect(res.status).toBe(422);
  });

  it("400s when the provider is not configured", async () => {
    const res = await handleOAuthStart(startRequest(RETURN_TO), { ...ENV, GITHUB_OAUTH_CLIENT_ID: "" }, "req_1");
    expect(res.status).toBe(400);
  });
});

describe("oauth callback handler", () => {
  async function startAndExtract(): Promise<{ state: string; nonce: string }> {
    const res = await handleOAuthStart(startRequest(RETURN_TO), ENV, "req_start");
    const setCookie = res.headers.get("set-cookie")!;
    const nonce = /sp_oauth_state=([0-9a-f]+)/.exec(setCookie)![1]!;
    const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
    return { state, nonce };
  }

  function callbackRequest(params: Record<string, string>, cookieNonce: string | null): Request {
    const url = new URL("http://localhost:8787/v1/auth/oauth/github/callback");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers: Record<string, string> = {};
    if (cookieNonce !== null) headers.cookie = `sp_oauth_state=${cookieNonce}`;
    return new Request(url.toString(), { method: "GET", headers });
  }

  it("completes a full round-trip (start → callback) and issues a session", async () => {
    const repo = createFakeRepository();
    const { state, nonce } = await startAndExtract();

    const res = await handleOAuthCallback(
      callbackRequest({ code: "abc", state }, nonce),
      ENV,
      "req_cb",
      { repo, provider: fakeProvider({ subject: "555", email: "u@example.com", emailVerified: true, displayName: "U" }) },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location.startsWith(`${RETURN_TO}#`)).toBe(true);
    expect(location).toContain("token=");
    expect(location).toContain("token_type=bearer");
    // one-time state cookie is cleared on the way out
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");

    expect(repo._users.size).toBe(1);
    expect(repo._sessions.size).toBe(1);
  });

  it("400s on a missing/invalid state", async () => {
    const repo = createFakeRepository();
    const res = await handleOAuthCallback(
      callbackRequest({ code: "abc", state: "garbage" }, "anything"),
      ENV,
      "req_cb",
      { repo, provider: fakeProvider({ subject: "1", email: "u@e.com", emailVerified: true, displayName: null }) },
    );
    expect(res.status).toBe(400);
  });

  it("400s when the state cookie is missing (CSRF defense)", async () => {
    const repo = createFakeRepository();
    const { state } = await startAndExtract();
    const res = await handleOAuthCallback(
      callbackRequest({ code: "abc", state }, null),
      ENV,
      "req_cb",
      { repo, provider: fakeProvider({ subject: "1", email: "u@e.com", emailVerified: true, displayName: null }) },
    );
    expect(res.status).toBe(400);
  });

  it("400s when the cookie nonce does not match the state nonce", async () => {
    const repo = createFakeRepository();
    const { state } = await startAndExtract();
    const res = await handleOAuthCallback(
      callbackRequest({ code: "abc", state }, "deadbeefdeadbeefdeadbeefdeadbeef"),
      ENV,
      "req_cb",
      { repo, provider: fakeProvider({ subject: "1", email: "u@e.com", emailVerified: true, displayName: null }) },
    );
    expect(res.status).toBe(400);
  });

  it("redirects with #error when the provider reports an error", async () => {
    const repo = createFakeRepository();
    const { state, nonce } = await startAndExtract();
    const res = await handleOAuthCallback(
      callbackRequest({ error: "access_denied", state }, nonce),
      ENV,
      "req_cb",
      { repo, provider: fakeProvider({ subject: "1", email: "u@e.com", emailVerified: true, displayName: null }) },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=access_denied");
    expect(repo._sessions.size).toBe(0);
  });

  it("redirects with #error=email_unverified for an unverified provider email", async () => {
    const repo = createFakeRepository();
    const { state, nonce } = await startAndExtract();
    const res = await handleOAuthCallback(
      callbackRequest({ code: "abc", state }, nonce),
      ENV,
      "req_cb",
      { repo, provider: fakeProvider({ subject: "1", email: "u@e.com", emailVerified: false, displayName: null }) },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=email_unverified");
    expect(repo._sessions.size).toBe(0);
  });
});
