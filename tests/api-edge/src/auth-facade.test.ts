import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isAuthRoute, handleAuthRoute } from "@api-edge/auth-facade";
import { resolveRequestId, notFound } from "@api-edge/http";

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripJsoncComments(text: string): string {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({ data: {}, meta: { requestId: "req_test", cursor: null } }),
): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(response.clone());
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createThrowingFetcher(error: Error): Fetcher {
  return {
    fetch(): Promise<Response> {
      return Promise.reject(error);
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

describe("api-edge auth facade", () => {
  describe("isAuthRoute", () => {
    it("matches /v1/auth/login/start", () => {
      expect(isAuthRoute("/v1/auth/login/start")).toBe(true);
    });

    it("matches /v1/auth/login/complete", () => {
      expect(isAuthRoute("/v1/auth/login/complete")).toBe(true);
    });

    it("matches /v1/auth/session", () => {
      expect(isAuthRoute("/v1/auth/session")).toBe(true);
    });

    it("matches /v1/auth/logout", () => {
      expect(isAuthRoute("/v1/auth/logout")).toBe(true);
    });

    it("matches /v1/auth/security-events", () => {
      expect(isAuthRoute("/v1/auth/security-events")).toBe(true);
    });

    it("matches /v1/auth/profile", () => {
      expect(isAuthRoute("/v1/auth/profile")).toBe(true);
    });

    it("does not match unknown auth routes", () => {
      expect(isAuthRoute("/v1/auth/unknown")).toBe(false);
    });

    it("does not match non-auth routes", () => {
      expect(isAuthRoute("/v1/organizations")).toBe(false);
    });
  });

  describe("route forwarding", () => {
    it("forwards POST /v1/auth/login/start to IDENTITY_WORKER", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const body = JSON.stringify({ email: "test@example.com" });
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_test123",
        },
        body,
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_test123",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/v1/auth/login/start");
      expect(calls[0]!.init.method).toBe("POST");
    });

    it("forwards POST /v1/auth/login/complete to IDENTITY_WORKER", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const body = JSON.stringify({ challengeId: "chl_abc", code: "123456" });
      const request = new Request("https://api.example.com/v1/auth/login/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_abc",
        "/v1/auth/login/complete",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/v1/auth/login/complete");
    });

    it("forwards GET /v1/auth/session to IDENTITY_WORKER", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/session", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc123.secret" },
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_abc",
        "/v1/auth/session",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/v1/auth/session");
    });

    it("forwards POST /v1/auth/logout to IDENTITY_WORKER", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/logout", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc123.secret" },
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_abc",
        "/v1/auth/logout",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/v1/auth/logout");
    });

    it("forwards GET /v1/auth/security-events to IDENTITY_WORKER", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/security-events", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc123.secret" },
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_sec1",
        "/v1/auth/security-events",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/v1/auth/security-events");
    });

    it("forwards GET /v1/auth/security-events with query string", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/security-events?limit=10&cursor=abc", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc123.secret" },
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_sec2",
        "/v1/auth/security-events",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("?limit=10&cursor=abc");
    });

    it("returns 405 for POST /v1/auth/security-events", async () => {
      const { fetcher } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/security-events", {
        method: "POST",
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_sec3",
        "/v1/auth/security-events",
      );

      expect(response.status).toBe(405);
      const json = (await response.json()) as any;
      expect(json.error.code).toBe("unsupported");
    });

    it("forwards GET /v1/auth/profile to IDENTITY_WORKER", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/profile", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc123.secret" },
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_prof1",
        "/v1/auth/profile",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/v1/auth/profile");
      expect(calls[0]!.init.method).toBe("GET");
    });

    it("forwards PATCH /v1/auth/profile to IDENTITY_WORKER with body", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const body = JSON.stringify({ displayName: "Alice" });
      const request = new Request("https://api.example.com/v1/auth/profile", {
        method: "PATCH",
        headers: {
          authorization: "Bearer sps_ses_abc123.secret",
          "content-type": "application/json",
        },
        body,
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_prof2",
        "/v1/auth/profile",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain("/v1/auth/profile");
      expect(calls[0]!.init.method).toBe("PATCH");
      expect(calls[0]!.init.body).toBeDefined();
    });

    it("returns 405 for POST /v1/auth/profile", async () => {
      const { fetcher } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/profile", {
        method: "POST",
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_prof3",
        "/v1/auth/profile",
      );

      expect(response.status).toBe(405);
      const json = (await response.json()) as any;
      expect(json.error.code).toBe("unsupported");
    });
  });

  describe("header preservation", () => {
    it("preserves authorization header", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/session", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc123.secret" },
      });

      await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_abc",
        "/v1/auth/session",
      );

      const forwarded = new Headers(calls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("authorization")).toBe("Bearer sps_ses_abc123.secret");
    });

    it("preserves x-request-id header", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/session", {
        method: "GET",
        headers: { "x-request-id": "req_custom123" },
      });

      await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_custom123",
        "/v1/auth/session",
      );

      const forwarded = new Headers(calls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("x-request-id")).toBe("req_custom123");
    });

    it("preserves traceparent header", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const traceparent = "00-abcdef1234567890-1234567890abcdef-01";
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          traceparent,
        },
        body: JSON.stringify({ email: "a@b.com" }),
      });

      await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_abc",
        "/v1/auth/login/start",
      );

      const forwarded = new Headers(calls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("traceparent")).toBe(traceparent);
    });

    it("preserves idempotency-key header", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "idem_123",
        },
        body: JSON.stringify({ email: "a@b.com" }),
      });

      await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_abc",
        "/v1/auth/login/start",
      );

      const forwarded = new Headers(calls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("idempotency-key")).toBe("idem_123");
    });

    it("preserves query string", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/session?foo=bar", {
        method: "GET",
      });

      await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_abc",
        "/v1/auth/session",
      );

      expect(calls[0]!.url).toContain("?foo=bar");
    });

    it("forwards request body for POST routes", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const body = JSON.stringify({ email: "test@example.com" });
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

      await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_abc",
        "/v1/auth/login/start",
      );

      expect(calls[0]!.init.body).toBeDefined();
    });
  });

  describe("downstream response passthrough", () => {
    it("passes through success envelope unchanged", async () => {
      const envelope = { data: { challengeId: "chl_abc" }, meta: { requestId: "req_123", cursor: null } };
      const downstream = Response.json(envelope, { status: 200 });
      const { fetcher } = createFakeFetcher(downstream);
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com" }),
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_123",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual(envelope);
    });

    it("passes through error envelope from downstream", async () => {
      const envelope = {
        error: {
          code: "validation_failed",
          message: "Validation failed",
          details: { fields: { email: ["required"] } },
          requestId: "req_456",
        },
      };
      const downstream = Response.json(envelope, { status: 422 });
      const { fetcher } = createFakeFetcher(downstream);
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_456",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(422);
      const json = await response.json();
      expect(json).toEqual(envelope);
    });
  });

  describe("error handling", () => {
    it("returns 503 with safe envelope when IDENTITY_WORKER is not configured", async () => {
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com" }),
      });

      const response = await handleAuthRoute(
        request,
        { ENVIRONMENT: "test" },
        "req_abc123",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(503);
      const json = await response.json() as any;
      expect(json.error.code).toBe("internal_error");
      expect(json.error.message).toBe("Authentication service unavailable");
      expect(json.error.requestId).toBe("req_abc123");
      expect(JSON.stringify(json)).not.toContain("identity-worker");
      expect(JSON.stringify(json)).not.toContain("stack");
    });

    it("returns 503 with safe envelope when service binding throws", async () => {
      const fetcher = createThrowingFetcher(
        new Error("Connection refused to meterwise-identity-worker-stage.internal"),
      );
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com" }),
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_abc123",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(503);
      const json = await response.json() as any;
      expect(json.error.code).toBe("internal_error");
      expect(json.error.message).toBe("Authentication service unavailable");
      expect(JSON.stringify(json)).not.toContain("Connection refused");
      expect(JSON.stringify(json)).not.toContain("meterwise-identity-worker-stage");
    });

    it("returns 405 for wrong method on auth routes", async () => {
      const { fetcher } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "GET",
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_abc",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(405);
      const json = await response.json() as any;
      expect(json.error.code).toBe("unsupported");
    });

    it("returns 404 for unknown auth routes", async () => {
      const { fetcher } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/unknown", {
        method: "POST",
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_abc",
        "/v1/auth/unknown",
      );

      expect(response.status).toBe(404);
      const json = await response.json() as any;
      expect(json.error.code).toBe("not_found");
    });
  });

  describe("request ID resolution", () => {
    it("preserves valid incoming x-request-id", () => {
      const request = new Request("https://api.example.com/v1/auth/session", {
        headers: { "x-request-id": "req_custom123" },
      });
      expect(resolveRequestId(request)).toBe("req_custom123");
    });

    it("generates a new request ID when header is missing", () => {
      const request = new Request("https://api.example.com/v1/auth/session");
      const id = resolveRequestId(request);
      expect(id).toMatch(/^req_[0-9a-f]{24}$/);
    });

    it("generates a new request ID when header is invalid", () => {
      const request = new Request("https://api.example.com/v1/auth/session", {
        headers: { "x-request-id": "invalid header with spaces!!!" },
      });
      const id = resolveRequestId(request);
      expect(id).toMatch(/^req_[0-9a-f]{24}$/);
    });
  });

  describe("notFound helper", () => {
    it("returns standard error envelope", async () => {
      const response = notFound("req_test", "/v1/some/unknown");
      expect(response.status).toBe(404);
      const json = await response.json() as any;
      expect(json.error.code).toBe("not_found");
      expect(json.error.requestId).toBe("req_test");
      expect(json.error.message).toContain("/v1/some/unknown");
    });
  });

  describe("config verification", () => {
    it("wrangler.jsonc has stage service binding to meterwise-identity-worker-stage", () => {
      const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsoncComments(raw));

      const stageServices = config.env?.stage?.services;
      expect(stageServices).toBeDefined();
      const identity = stageServices.find((s: any) => s.binding === "IDENTITY_WORKER");
      expect(identity).toBeDefined();
      expect(identity.service).toBe("meterwise-identity-worker-stage");
    });

    it("wrangler.jsonc has prod service binding to meterwise-identity-worker-prod", () => {
      const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsoncComments(raw));

      const prodServices = config.env?.prod?.services;
      expect(prodServices).toBeDefined();
      const identity = prodServices.find((s: any) => s.binding === "IDENTITY_WORKER");
      expect(identity).toBeDefined();
      expect(identity.service).toBe("meterwise-identity-worker-prod");
    });

    it("stage does not bind to prod identity worker", () => {
      const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsoncComments(raw));

      const stageServices = config.env?.stage?.services ?? [];
      for (const svc of stageServices) {
        expect(svc.service).not.toContain("prod");
      }
    });

    it("prod does not bind to stage identity worker", () => {
      const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsoncComments(raw));

      const prodServices = config.env?.prod?.services ?? [];
      for (const svc of prodServices) {
        expect(svc.service).not.toContain("stage");
      }
    });
  });

  describe("oauth routes", () => {
    it("recognises the oauth routes via isAuthRoute", () => {
      expect(isAuthRoute("/v1/auth/oauth/providers")).toBe(true);
      expect(isAuthRoute("/v1/auth/oauth/github/start")).toBe(true);
      expect(isAuthRoute("/v1/auth/oauth/github/callback")).toBe(true);
      expect(isAuthRoute("/v1/auth/oauth/github")).toBe(false);
    });

    it("forwards GET /v1/auth/oauth/providers to IDENTITY_WORKER", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/oauth/providers", { method: "GET" });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_p",
        "/v1/auth/oauth/providers",
      );

      expect(response.status).toBe(200);
      expect(calls[0]!.url).toContain("/v1/auth/oauth/providers");
      expect(calls[0]!.init.method).toBe("GET");
    });

    it("returns 405 for POST to an oauth route", async () => {
      const { fetcher } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/oauth/github/start", { method: "POST" });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_p",
        "/v1/auth/oauth/github/start",
      );

      expect(response.status).toBe(405);
    });

    it("forwards the cookie header and uses manual redirect on callback", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request(
        "https://api.example.com/v1/auth/oauth/github/callback?code=abc&state=xyz",
        { method: "GET", headers: { cookie: "sp_oauth_state=nonce123" } },
      );

      await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_cb",
        "/v1/auth/oauth/github/callback",
      );

      const forwarded = new Headers(calls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("cookie")).toBe("sp_oauth_state=nonce123");
      expect(calls[0]!.init.redirect).toBe("manual");
      expect(calls[0]!.url).toContain("?code=abc&state=xyz");
    });

    it("passes a 302 redirect (Location + Set-Cookie) back to the caller", async () => {
      const downstream = new Response(null, {
        status: 302,
        headers: {
          location: "https://github.com/login/oauth/authorize?x=1",
          "set-cookie": "sp_oauth_state=abc; Path=/v1/auth/oauth; HttpOnly",
        },
      });
      const { fetcher } = createFakeFetcher(downstream);
      const request = new Request("https://api.example.com/v1/auth/oauth/github/start?return_to=x", {
        method: "GET",
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_s",
        "/v1/auth/oauth/github/start",
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("github.com/login/oauth/authorize");
      expect(response.headers.get("set-cookie")).toContain("sp_oauth_state=abc");
    });
  });
});
