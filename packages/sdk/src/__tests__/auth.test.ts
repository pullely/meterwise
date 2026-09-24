// Tests for `AuthClient` (Task 0103 — closes the U10 SDK gap).
//
// Coverage:
//   - URL shape on every method (loginStart/loginComplete/getSession/logout/
//     getProfile/updateProfile)
//   - HTTP verb correctness (POST, GET, PATCH per auth-facade route table)
//   - POST/PATCH bodies serialize to JSON
//   - Stripe parity: caller-owned idempotency-key passthrough on POSTs
//   - Stripe parity: NOT auto-generated when caller omits the key
//   - MeterwiseError hierarchy propagation with request-id passthrough
//     (Unauthenticated / RateLimit / Validation / Internal)
//   - x-request-id surfacing through the envelope (custom requestId opt)

import { describe, expect, it, vi } from "vitest";

import { Meterwise } from "../index.js";
import {
  InternalError,
  RateLimitError,
  UnauthenticatedError,
  ValidationError,
} from "../errors.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function captureFetch(response: Response): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fn: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response.clone();
  });
  return { fetch: fn, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function envelope<T>(
  data: T,
): { data: T; meta: { requestId: string; cursor: null } } {
  return { data, meta: { requestId: "req_test", cursor: null } };
}

function errorResponse(code: string, status: number): Response {
  return jsonResponse(
    {
      error: {
        code,
        message: `synthetic ${code}`,
        requestId: "req_err",
      },
    },
    { status },
  );
}

function client(fetchImpl: typeof fetch): Meterwise {
  return new Meterwise({ baseUrl: "https://api.test", fetch: fetchImpl });
}

describe("AuthClient", () => {
  it("loginStart POSTs /v1/auth/login/start with the email body", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({
          challengeId: "chl_1",
          expiresAt: "2026-06-01T00:00:00Z",
          delivery: { mode: "local_debug", emailHint: "u@e.com" },
        }),
      ),
    );
    await client(fetch).auth.loginStart({ email: "u@e.com" });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.test/v1/auth/login/start");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({ email: "u@e.com" });
  });

  it("loginStart propagates the caller-supplied idempotency-key", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({
          challengeId: "chl_1",
          expiresAt: "2026-06-01T00:00:00Z",
          delivery: { mode: "local_debug", emailHint: "u@e.com" },
        }),
      ),
    );
    await client(fetch).auth.loginStart(
      { email: "u@e.com" },
      { idempotencyKey: "ikey_login_1" },
    );
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_login_1");
  });

  it("loginStart does NOT auto-generate an idempotency-key when omitted", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({
          challengeId: "chl_1",
          expiresAt: "2026-06-01T00:00:00Z",
          delivery: { mode: "local_debug", emailHint: "u@e.com" },
        }),
      ),
    );
    await client(fetch).auth.loginStart({ email: "u@e.com" });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    // Stripe parity: caller-owned only.
    expect(headers.get("idempotency-key")).toBeNull();
  });

  it("loginComplete POSTs /v1/auth/login/complete with the body and returns a token", async () => {
    const body = {
      token: "tok_abc",
      tokenType: "bearer" as const,
      expiresAt: "2026-06-01T00:00:00Z",
      user: { id: "u_1", email: "u@e.com", displayName: null },
    };
    const { fetch, calls } = captureFetch(jsonResponse(envelope(body)));
    const out = await client(fetch).auth.loginComplete({
      challengeId: "chl_1",
      code: "123456",
    });
    expect(calls[0]!.url).toBe("https://api.test/v1/auth/login/complete");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      challengeId: "chl_1",
      code: "123456",
    });
    expect(out.token).toBe("tok_abc");
    expect(out.user.id).toBe("u_1");
  });

  it("loginComplete propagates idempotency-key", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({
          token: "tok_abc",
          tokenType: "bearer",
          expiresAt: "2026-06-01T00:00:00Z",
          user: { id: "u_1", email: "u@e.com", displayName: null },
        }),
      ),
    );
    await client(fetch).auth.loginComplete(
      { challengeId: "chl_1", code: "123456" },
      { idempotencyKey: "ikey_complete_1" },
    );
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_complete_1");
  });

  it("getSession GETs /v1/auth/session", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({
          session: {
            id: "sess_1",
            expiresAt: "2026-06-01T00:00:00Z",
            createdAt: "2026-05-31T00:00:00Z",
          },
          user: { id: "u_1", email: "u@e.com", displayName: "U" },
        }),
      ),
    );
    const out = await client(fetch).auth.getSession();
    expect(calls[0]!.url).toBe("https://api.test/v1/auth/session");
    expect(calls[0]!.init.method).toBe("GET");
    expect(out.session.id).toBe("sess_1");
  });

  it("logout POSTs /v1/auth/logout with no body", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ success: true })),
    );
    await client(fetch).auth.logout();
    expect(calls[0]!.url).toBe("https://api.test/v1/auth/logout");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("logout propagates idempotency-key when supplied", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ success: true })),
    );
    await client(fetch).auth.logout({ idempotencyKey: "ikey_logout_1" });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_logout_1");
  });

  it("getProfile GETs /v1/auth/profile", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({
          user: { id: "u_1", email: "u@e.com", displayName: "U" },
        }),
      ),
    );
    const out = await client(fetch).auth.getProfile();
    expect(calls[0]!.url).toBe("https://api.test/v1/auth/profile");
    expect(calls[0]!.init.method).toBe("GET");
    expect(out.user.email).toBe("u@e.com");
  });

  it("updateProfile PATCHes /v1/auth/profile with the body", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({
          user: { id: "u_1", email: "u@e.com", displayName: "New Name" },
        }),
      ),
    );
    const out = await client(fetch).auth.updateProfile({
      displayName: "New Name",
    });
    expect(calls[0]!.url).toBe("https://api.test/v1/auth/profile");
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      displayName: "New Name",
    });
    expect(out.user.displayName).toBe("New Name");
  });

  it("updateProfile accepts a null displayName (clear)", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({
          user: { id: "u_1", email: "u@e.com", displayName: null },
        }),
      ),
    );
    await client(fetch).auth.updateProfile({ displayName: null });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      displayName: null,
    });
  });

  it("getSession surfaces UnauthenticatedError on 401 with request-id", async () => {
    const { fetch } = captureFetch(errorResponse("unauthenticated", 401));
    await expect(client(fetch).auth.getSession()).rejects.toMatchObject({
      constructor: UnauthenticatedError,
      requestId: "req_err",
    });
  });

  it("loginStart surfaces ValidationError on 422", async () => {
    const { fetch } = captureFetch(errorResponse("validation_failed", 422));
    await expect(
      client(fetch).auth.loginStart({ email: "" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("loginComplete surfaces RateLimitError on 429", async () => {
    const { fetch } = captureFetch(errorResponse("rate_limited", 429));
    await expect(
      client(fetch).auth.loginComplete({ challengeId: "chl_x", code: "000000" }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("getProfile surfaces InternalError on 500", async () => {
    const { fetch } = captureFetch(errorResponse("internal_error", 500));
    await expect(client(fetch).auth.getProfile()).rejects.toBeInstanceOf(
      InternalError,
    );
  });

  it("forwards a caller-supplied requestId via x-request-id", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        envelope({
          user: { id: "u_1", email: "u@e.com", displayName: null },
        }),
      ),
    );
    await client(fetch).auth.getProfile({ requestId: "req_caller_1" });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("x-request-id")).toBe("req_caller_1");
  });

  it("listOAuthProviders GETs /v1/auth/oauth/providers", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ providers: [{ id: "github", displayName: "GitHub" }] })),
    );
    const out = await client(fetch).auth.listOAuthProviders();
    expect(calls[0]!.url).toBe("https://api.test/v1/auth/oauth/providers");
    expect(calls[0]!.init.method).toBe("GET");
    expect(out.providers[0]!.id).toBe("github");
  });

  it("oauthStartUrl builds an absolute start URL carrying return_to", () => {
    const { fetch } = captureFetch(jsonResponse(envelope({ providers: [] })));
    const url = client(fetch).auth.oauthStartUrl("github", "https://console.test/auth/callback");
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://api.test/v1/auth/oauth/github/start");
    expect(parsed.searchParams.get("return_to")).toBe("https://console.test/auth/callback");
  });

  it("client.auth is wired onto the Meterwise class", () => {
    const { fetch } = captureFetch(jsonResponse(envelope({ success: true })));
    const c = client(fetch);
    expect(typeof c.auth.loginStart).toBe("function");
    expect(typeof c.auth.loginComplete).toBe("function");
    expect(typeof c.auth.getSession).toBe("function");
    expect(typeof c.auth.logout).toBe("function");
    expect(typeof c.auth.getProfile).toBe("function");
    expect(typeof c.auth.updateProfile).toBe("function");
    expect(typeof c.auth.listOAuthProviders).toBe("function");
    expect(typeof c.auth.oauthStartUrl).toBe("function");
  });
});
