import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isOrgRoute, handleOrgRoute } from "@api-edge/org-facade";

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

function createSessionFetcher(userId: string): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      if (url.includes("/v1/auth/resolve")) {
        return Promise.resolve(
          Response.json({
            data: {
              actor: { actorType: "user", actorId: userId, email: "user@test.com" },
              session: { id: "ses_abc", expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
              user: { id: userId, email: "user@test.com", displayName: "Test" },
            },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: {}, meta: { requestId: "req_test", cursor: null } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

describe("api-edge org facade", () => {
  describe("isOrgRoute", () => {
    it("matches /v1/organizations", () => {
      expect(isOrgRoute("/v1/organizations")).toBe(true);
    });

    it("matches /v1/organizations/{orgId}", () => {
      expect(isOrgRoute("/v1/organizations/org_abc123def456")).toBe(true);
    });

    it("matches /v1/organizations/{orgId}/members", () => {
      expect(isOrgRoute("/v1/organizations/org_abc/members")).toBe(true);
    });

    it("matches /v1/organizations/{orgId}/members/{memberId}", () => {
      expect(isOrgRoute("/v1/organizations/org_abc/members/mem_abc123")).toBe(true);
    });

    it("does not match deeper nested org routes", () => {
      expect(isOrgRoute("/v1/organizations/org_abc/members/mem_abc123/extra")).toBe(false);
    });

    it("does not match /v1/auth routes", () => {
      expect(isOrgRoute("/v1/auth/resolve")).toBe(false);
    });
  });

  describe("session resolution through IDENTITY_WORKER", () => {
    it("resolves session and forwards actor context to MEMBERSHIP_WORKER", async () => {
      const { fetcher: identityFetcher, calls: identityCalls } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      expect(identityCalls).toHaveLength(1);
      expect(identityCalls[0]!.url).toContain("/v1/auth/resolve");

      expect(membershipCalls).toHaveLength(1);
      const forwardedHeaders = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
      expect(forwardedHeaders.get("x-actor-subject-id")).toBe("usr_abc123");
      expect(forwardedHeaders.get("x-actor-subject-type")).toBe("user");
    });

    it("does not forward raw bearer token to MEMBERSHIP_WORKER", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      const forwardedHeaders = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
      expect(forwardedHeaders.get("authorization")).toBeNull();
      const rawCall = JSON.stringify(membershipCalls[0]);
      expect(rawCall).not.toContain("sps_ses_");
      expect(rawCall).not.toContain("Bearer");
    });

    it("returns unauthenticated when bearer token is missing", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "GET",
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      expect(response.status).toBe(401);
      const json = await response.json() as any;
      expect(json.error.code).toBe("unauthenticated");
    });

    it("returns unauthenticated when identity service returns error", async () => {
      const identityFetcher = {
        fetch(): Promise<Response> {
          return Promise.resolve(
            Response.json({ error: { code: "unauthenticated", message: "Invalid token", requestId: "req_x" } }, { status: 401 }),
          );
        },
        connect() { throw new Error("not implemented"); },
      } as unknown as Fetcher;
      const { fetcher: membershipFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.bad" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      expect(response.status).toBe(401);
    });
  });

  describe("error handling", () => {
    it("returns 503 when IDENTITY_WORKER is not configured", async () => {
      const { fetcher: membershipFetcher } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/organizations", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      expect(response.status).toBe(503);
      const json = await response.json() as any;
      expect(json.error.code).toBe("internal_error");
      expect(json.error.message).toBe("Authentication service unavailable");
      expect(JSON.stringify(json)).not.toContain("identity-worker");
    });

    it("returns 503 when MEMBERSHIP_WORKER is not configured", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const request = new Request("https://api.example.com/v1/organizations", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      expect(response.status).toBe(503);
      const json = await response.json() as any;
      expect(json.error.code).toBe("internal_error");
      expect(json.error.message).toBe("Membership service unavailable");
      expect(JSON.stringify(json)).not.toContain("membership-worker");
    });

    it("returns 503 with safe envelope when membership binding throws", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const membershipFetcher = createThrowingFetcher(
        new Error("Connection refused to meterwise-membership-worker-stage.internal"),
      );

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      expect(response.status).toBe(503);
      const json = await response.json() as any;
      expect(json.error.message).toBe("Membership service unavailable");
      expect(JSON.stringify(json)).not.toContain("Connection refused");
      expect(JSON.stringify(json)).not.toContain("meterwise-membership-worker-stage");
    });

    it("returns 405 for unsupported method on /v1/organizations", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      expect(response.status).toBe(405);
      const json = await response.json() as any;
      expect(json.error.code).toBe("unsupported");
    });

    it("returns 405 for non-GET on /v1/organizations/:id", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc",
      );

      expect(response.status).toBe(405);
    });
  });

  describe("downstream response passthrough", () => {
    it("passes through membership success envelope", async () => {
      const envelope = { data: { organizations: [] }, meta: { requestId: "req_123", cursor: null } };
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher(Response.json(envelope));

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual(envelope);
    });

    it("passes through membership error envelope", async () => {
      const envelope = { error: { code: "conflict", message: "Organization already exists", details: {}, requestId: "req_123" } };
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher(Response.json(envelope, { status: 409 }));

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      expect(response.status).toBe(409);
      const json = await response.json();
      expect(json).toEqual(envelope);
    });
  });

  describe("header forwarding", () => {
    it("forwards x-request-id to membership", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret", "x-request-id": "req_custom" },
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_custom",
        "/v1/organizations",
      );

      const forwarded = new Headers(calls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("x-request-id")).toBe("req_custom");
    });

    it("forwards traceparent to membership", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls } = createFakeFetcher();
      const traceparent = "00-abcdef1234567890-1234567890abcdef-01";

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret", traceparent },
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      const forwarded = new Headers(calls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("traceparent")).toBe(traceparent);
    });

    it("forwards idempotency-key to membership", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json", "idempotency-key": "idem_xyz" },
        body: JSON.stringify({ name: "Test" }),
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      const forwarded = new Headers(calls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("idempotency-key")).toBe("idem_xyz");
    });

    it("forwards POST body to membership", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "My Org" }),
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      expect(calls[0]!.init.body).toBeDefined();
    });
  });

  describe("binding verification config", () => {
    it("wrangler.jsonc has stage MEMBERSHIP_WORKER binding to meterwise-membership-worker-stage", () => {
      const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsoncComments(raw));

      const stageServices = config.env?.stage?.services;
      expect(stageServices).toBeDefined();
      const membership = stageServices.find((s: any) => s.binding === "MEMBERSHIP_WORKER");
      expect(membership).toBeDefined();
      expect(membership.service).toBe("meterwise-membership-worker-stage");
    });

    it("wrangler.jsonc has prod MEMBERSHIP_WORKER binding to meterwise-membership-worker-prod", () => {
      const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsoncComments(raw));

      const prodServices = config.env?.prod?.services;
      expect(prodServices).toBeDefined();
      const membership = prodServices.find((s: any) => s.binding === "MEMBERSHIP_WORKER");
      expect(membership).toBeDefined();
      expect(membership.service).toBe("meterwise-membership-worker-prod");
    });

    it("stage does not bind to prod membership worker", () => {
      const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsoncComments(raw));

      const stageServices = config.env?.stage?.services ?? [];
      const membershipBindings = stageServices.filter((s: any) => s.binding === "MEMBERSHIP_WORKER");
      for (const svc of membershipBindings) {
        expect(svc.service).not.toContain("prod");
      }
    });

    it("prod does not bind to stage membership worker", () => {
      const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsoncComments(raw));

      const prodServices = config.env?.prod?.services ?? [];
      const membershipBindings = prodServices.filter((s: any) => s.binding === "MEMBERSHIP_WORKER");
      for (const svc of membershipBindings) {
        expect(svc.service).not.toContain("stage");
      }
    });
  });

  describe("members route /v1/organizations/{orgId}/members", () => {
    it("forwards GET /v1/organizations/{orgId}/members to MEMBERSHIP_WORKER", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/members", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/members",
      );

      expect(response.status).toBe(200);
      expect(membershipCalls).toHaveLength(1);
      expect(membershipCalls[0]!.url).toContain("/v1/organizations/org_abc123/members");
    });

    it("only allows GET method", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/members", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/members",
      );

      expect(response.status).toBe(405);
      const json = await response.json() as any;
      expect(json.error.code).toBe("unsupported");
    });

    it("resolves auth and forwards actor headers", async () => {
      const { fetcher: identityFetcher, calls: identityCalls } = createSessionFetcher("usr_member_actor");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/members", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/members",
      );

      expect(identityCalls).toHaveLength(1);
      expect(identityCalls[0]!.url).toContain("/v1/auth/resolve");

      const forwarded = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("x-actor-subject-id")).toBe("usr_member_actor");
      expect(forwarded.get("x-actor-subject-type")).toBe("user");
    });

    it("does not forward raw bearer token to MEMBERSHIP_WORKER", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/members", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_secret_token.xyz" },
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/members",
      );

      const forwarded = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("authorization")).toBeNull();
      const rawCall = JSON.stringify(membershipCalls[0]);
      expect(rawCall).not.toContain("sps_ses_secret_token");
      expect(rawCall).not.toContain("Bearer");
    });

    it("passes through downstream success response", async () => {
      const envelope = { data: { members: [] }, meta: { requestId: "req_123", cursor: null } };
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher(Response.json(envelope));

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/members", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/members",
      );

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toEqual(envelope);
    });

    it("passes through downstream error response", async () => {
      const envelope = { error: { code: "not_found", message: "Organization not found", details: {}, requestId: "req_123" } };
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher(Response.json(envelope, { status: 404 }));

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/members", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/members",
      );

      expect(response.status).toBe(404);
      const json = await response.json();
      expect(json).toEqual(envelope);
    });
  });

  describe("member item route /v1/organizations/{orgId}/members/{memberId}", () => {
    it("forwards PATCH to MEMBERSHIP_WORKER", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/members/mem_xyz", {
        method: "PATCH",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/members/mem_xyz",
      );

      expect(response.status).toBe(200);
      expect(membershipCalls).toHaveLength(1);
      expect(membershipCalls[0]!.url).toContain("/v1/organizations/org_abc/members/mem_xyz");
      expect(membershipCalls[0]!.init.method).toBe("PATCH");
    });

    it("forwards DELETE to MEMBERSHIP_WORKER", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/members/mem_xyz", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/members/mem_xyz",
      );

      expect(response.status).toBe(200);
      expect(membershipCalls).toHaveLength(1);
      expect(membershipCalls[0]!.url).toContain("/v1/organizations/org_abc/members/mem_xyz");
      expect(membershipCalls[0]!.init.method).toBe("DELETE");
    });

    it("forwards PATCH body to MEMBERSHIP_WORKER", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/members/mem_xyz", {
        method: "PATCH",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ role: "editor" }),
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/members/mem_xyz",
      );

      expect(membershipCalls[0]!.init.body).toBeDefined();
    });

    it("returns 405 for GET on member item route", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/members/mem_xyz", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/members/mem_xyz",
      );

      expect(response.status).toBe(405);
      const json = await response.json() as any;
      expect(json.error.code).toBe("unsupported");
    });

    it("returns 405 for POST on member item route", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/members/mem_xyz", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/members/mem_xyz",
      );

      expect(response.status).toBe(405);
      const json = await response.json() as any;
      expect(json.error.code).toBe("unsupported");
    });

    it("returns 405 for PUT on member item route", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/members/mem_xyz", {
        method: "PUT",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/members/mem_xyz",
      );

      expect(response.status).toBe(405);
      const json = await response.json() as any;
      expect(json.error.code).toBe("unsupported");
    });

    it("resolves auth and forwards actor headers", async () => {
      const { fetcher: identityFetcher, calls: identityCalls } = createSessionFetcher("usr_member_actor");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/members/mem_xyz", {
        method: "PATCH",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/members/mem_xyz",
      );

      expect(identityCalls).toHaveLength(1);
      expect(identityCalls[0]!.url).toContain("/v1/auth/resolve");

      const forwarded = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("x-actor-subject-id")).toBe("usr_member_actor");
      expect(forwarded.get("x-actor-subject-type")).toBe("user");
    });

    it("does not forward raw bearer token to MEMBERSHIP_WORKER", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/members/mem_xyz", {
        method: "PATCH",
        headers: { authorization: "Bearer sps_ses_secret_token.xyz", "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/members/mem_xyz",
      );

      const forwarded = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("authorization")).toBeNull();
      const rawCall = JSON.stringify(membershipCalls[0]);
      expect(rawCall).not.toContain("sps_ses_secret_token");
      expect(rawCall).not.toContain("Bearer");
    });
  });

  describe("pagination query-string forwarding", () => {
    it("forwards limit and cursor query params to membership-worker for /v1/organizations", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations?limit=10&cursor=abc123", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      const membershipCall = calls.find((c) => c.url.includes("/v1/organizations"));
      expect(membershipCall).toBeDefined();
      expect(membershipCall!.url).toContain("limit=10");
      expect(membershipCall!.url).toContain("cursor=abc123");
    });

    it("forwards limit and cursor query params to membership-worker for /v1/organizations/{orgId}/members", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/members?limit=25&cursor=xyz789", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/members",
      );

      const membershipCall = calls.find((c) => c.url.includes("/members"));
      expect(membershipCall).toBeDefined();
      expect(membershipCall!.url).toContain("limit=25");
      expect(membershipCall!.url).toContain("cursor=xyz789");
    });

    it("does not forward authorization header to membership-worker", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations?limit=5", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      const membershipCall = calls.find((c) => c.url.includes("/v1/organizations"));
      expect(membershipCall).toBeDefined();
      const headers = membershipCall!.init.headers as Headers;
      expect(headers.get("authorization")).toBeNull();
    });

    it("preserves empty query string when no params provided", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations",
      );

      const membershipCall = calls.find((c) => c.url.includes("/v1/organizations"));
      expect(membershipCall).toBeDefined();
      const url = new URL(membershipCall!.url);
      expect(url.pathname).toBe("/v1/organizations");
    });
  });

  describe("invitation routes", () => {
    describe("isOrgRoute for invitation paths", () => {
      it("matches /v1/organizations/{orgId}/invitations", () => {
        expect(isOrgRoute("/v1/organizations/org_abc/invitations")).toBe(true);
      });

      it("matches /v1/organizations/{orgId}/invitations/{invitationId}", () => {
        expect(isOrgRoute("/v1/organizations/org_abc/invitations/inv_def")).toBe(true);
      });
    });

    describe("POST /v1/organizations/{orgId}/invitations", () => {
      it("forwards POST to MEMBERSHIP_WORKER with body", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations", {
          method: "POST",
          headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", role: "viewer" }),
        });

        const response = await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations",
        );

        expect(response.status).toBe(200);
        expect(membershipCalls).toHaveLength(1);
        expect(membershipCalls[0]!.url).toContain("/v1/organizations/org_abc/invitations");
        expect(membershipCalls[0]!.init.method).toBe("POST");
        expect(membershipCalls[0]!.init.body).toBeDefined();
      });

      it("resolves auth before forwarding", async () => {
        const { fetcher: identityFetcher, calls: identityCalls } = createSessionFetcher("usr_admin");
        const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations", {
          method: "POST",
          headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", role: "viewer" }),
        });

        await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations",
        );

        expect(identityCalls).toHaveLength(1);
        const forwarded = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
        expect(forwarded.get("x-actor-subject-id")).toBe("usr_admin");
        expect(forwarded.get("x-actor-subject-type")).toBe("user");
      });

      it("does not forward bearer token", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations", {
          method: "POST",
          headers: { authorization: "Bearer sps_ses_secret.token", "content-type": "application/json" },
          body: JSON.stringify({ email: "test@example.com", role: "viewer" }),
        });

        await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations",
        );

        const forwarded = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
        expect(forwarded.get("authorization")).toBeNull();
        const rawCall = JSON.stringify(membershipCalls[0]);
        expect(rawCall).not.toContain("sps_ses_secret");
      });
    });

    describe("GET /v1/organizations/{orgId}/invitations", () => {
      it("forwards GET with query string to MEMBERSHIP_WORKER", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations?limit=10&cursor=xyz", {
          method: "GET",
          headers: { authorization: "Bearer sps_ses_abc.secret" },
        });

        const response = await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations",
        );

        expect(response.status).toBe(200);
        expect(membershipCalls[0]!.url).toContain("limit=10");
        expect(membershipCalls[0]!.url).toContain("cursor=xyz");
      });
    });

    describe("method restrictions on invitation collection", () => {
      it("returns 405 for DELETE on collection route", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations", {
          method: "DELETE",
          headers: { authorization: "Bearer sps_ses_abc.secret" },
        });

        const response = await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations",
        );

        expect(response.status).toBe(405);
        const json = await response.json() as any;
        expect(json.error.code).toBe("unsupported");
      });

      it("returns 405 for PUT on collection route", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations", {
          method: "PUT",
          headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
          body: JSON.stringify({}),
        });

        const response = await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations",
        );

        expect(response.status).toBe(405);
      });
    });

    describe("DELETE /v1/organizations/{orgId}/invitations/{invitationId}", () => {
      it("forwards DELETE to MEMBERSHIP_WORKER", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations/inv_def", {
          method: "DELETE",
          headers: { authorization: "Bearer sps_ses_abc.secret" },
        });

        const response = await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations/inv_def",
        );

        expect(response.status).toBe(200);
        expect(membershipCalls).toHaveLength(1);
        expect(membershipCalls[0]!.url).toContain("/v1/organizations/org_abc/invitations/inv_def");
        expect(membershipCalls[0]!.init.method).toBe("DELETE");
      });

      it("returns 405 for GET on item route", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations/inv_def", {
          method: "GET",
          headers: { authorization: "Bearer sps_ses_abc.secret" },
        });

        const response = await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations/inv_def",
        );

        expect(response.status).toBe(405);
        const json = await response.json() as any;
        expect(json.error.code).toBe("unsupported");
      });

      it("returns 405 for POST on item route", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations/inv_def", {
          method: "POST",
          headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
          body: JSON.stringify({}),
        });

        const response = await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations/inv_def",
        );

        expect(response.status).toBe(405);
      });

      it("does not forward bearer token for DELETE", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations/inv_def", {
          method: "DELETE",
          headers: { authorization: "Bearer sps_ses_secret.xyz" },
        });

        await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations/inv_def",
        );

        const forwarded = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
        expect(forwarded.get("authorization")).toBeNull();
        const rawCall = JSON.stringify(membershipCalls[0]);
        expect(rawCall).not.toContain("sps_ses_secret");
      });
    });

    describe("downstream passthrough for invitation routes", () => {
      it("passes through success response from membership for create", async () => {
        const envelope = { data: { invitation: { id: "inv_abc" } }, meta: { requestId: "req_123", cursor: null } };
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher } = createFakeFetcher(Response.json(envelope, { status: 201 }));

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations", {
          method: "POST",
          headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
          body: JSON.stringify({ email: "test@x.com", role: "viewer" }),
        });

        const response = await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations",
        );

        expect(response.status).toBe(201);
        const json = await response.json();
        expect(json).toEqual(envelope);
      });

      it("passes through error response from membership for revoke", async () => {
        const envelope = { error: { code: "not_found", message: "Invitation not found", details: {}, requestId: "req_123" } };
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher } = createFakeFetcher(Response.json(envelope, { status: 404 }));

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations/inv_def", {
          method: "DELETE",
          headers: { authorization: "Bearer sps_ses_abc.secret" },
        });

        const response = await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations/inv_def",
        );

        expect(response.status).toBe(404);
        const json = await response.json();
        expect(json).toEqual(envelope);
      });
    });

    describe("POST /v1/organizations/{orgId}/invitations/accept", () => {
      it("matches isOrgRoute for accept path", () => {
        expect(isOrgRoute("/v1/organizations/org_abc/invitations/accept")).toBe(true);
      });

      it("forwards POST with body to MEMBERSHIP_WORKER", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations/accept", {
          method: "POST",
          headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
          body: JSON.stringify({ token: "a".repeat(64) }),
        });

        const response = await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations/accept",
        );

        expect(response.status).toBe(200);
        expect(membershipCalls).toHaveLength(1);
        expect(membershipCalls[0]!.url).toContain("/v1/organizations/org_abc/invitations/accept");
        expect(membershipCalls[0]!.init.method).toBe("POST");
        expect(membershipCalls[0]!.init.body).toBeDefined();
      });

      it("resolves auth before forwarding", async () => {
        const { fetcher: identityFetcher, calls: identityCalls } = createSessionFetcher("usr_accept");
        const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations/accept", {
          method: "POST",
          headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
          body: JSON.stringify({ token: "b".repeat(64) }),
        });

        await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations/accept",
        );

        expect(identityCalls).toHaveLength(1);
        const forwarded = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
        expect(forwarded.get("x-actor-subject-id")).toBe("usr_accept");
        expect(forwarded.get("x-actor-subject-type")).toBe("user");
      });

      it("forwards x-actor-email from identity session response", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_accept");
        const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations/accept", {
          method: "POST",
          headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
          body: JSON.stringify({ token: "c".repeat(64) }),
        });

        await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations/accept",
        );

        const forwarded = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
        expect(forwarded.get("x-actor-email")).toBe("user@test.com");
      });

      it("forwards request even when identity response has no email", async () => {
        const noEmailFetcher = {
          fetch(input: string | Request | URL): Promise<Response> {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (url.includes("/v1/auth/resolve")) {
              return Promise.resolve(
                Response.json({
                  data: { actor: { actorType: "user", actorId: "usr_123" }, session: { id: "ses_abc" }, user: { id: "usr_123" } },
                  meta: { requestId: "req_inner", cursor: null },
                }),
              );
            }
            return Promise.resolve(Response.json({ data: {}, meta: { requestId: "req_test", cursor: null } }));
          },
          connect() { throw new Error("not implemented"); },
        } as unknown as Fetcher;

        const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations/accept", {
          method: "POST",
          headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
          body: JSON.stringify({ token: "d".repeat(64) }),
        });

        const response = await handleOrgRoute(
          request,
          { IDENTITY_WORKER: noEmailFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations/accept",
        );

        expect(response.status).toBe(200);
        expect(membershipCalls).toHaveLength(1);
        const forwarded = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
        expect(forwarded.get("x-actor-email")).toBe("");
      });

      it("returns 405 for non-POST methods", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations/accept", {
          method: "GET",
          headers: { authorization: "Bearer sps_ses_abc.secret" },
        });

        const response = await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations/accept",
        );

        expect(response.status).toBe(405);
      });

      it("does not forward bearer token to MEMBERSHIP_WORKER", async () => {
        const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
        const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

        const request = new Request("https://api.example.com/v1/organizations/org_abc/invitations/accept", {
          method: "POST",
          headers: { authorization: "Bearer sps_ses_secret.bearer", "content-type": "application/json" },
          body: JSON.stringify({ token: "e".repeat(64) }),
        });

        await handleOrgRoute(
          request,
          { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
          "req_test",
          "/v1/organizations/org_abc/invitations/accept",
        );

        const forwarded = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
        expect(forwarded.get("authorization")).toBeNull();
        const rawCall = JSON.stringify(membershipCalls[0]);
        expect(rawCall).not.toContain("sps_ses_secret");
      });
    });
  });
});
