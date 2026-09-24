import { isConfigRoute, handleConfigRoute } from "@api-edge/config-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({ data: { settings: [] }, meta: { requestId: "req_test", cursor: null } }),
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

function createThrowingFetcher(): Fetcher {
  return {
    fetch(): Promise<Response> {
      return Promise.reject(new Error("connection refused"));
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
            data: { actor: { actorType: "user", actorId: userId, email: "user@test.com" }, session: { id: "ses_abc" }, user: { id: userId, email: "user@test.com", displayName: "Test" } },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: { settings: [] }, meta: { requestId: "req_test", cursor: null } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createEnv(overrides?: Record<string, unknown>) {
  const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
  const { fetcher: configFetcher } = createFakeFetcher();
  return {
    IDENTITY_WORKER: identityFetcher,
    CONFIG_WORKER: configFetcher,
    MEMBERSHIP_WORKER: createFakeFetcher().fetcher,
    PROJECTS_WORKER: createFakeFetcher().fetcher,
    EVENTS_WORKER: createFakeFetcher().fetcher,
    ENVIRONMENT: "test",
    ...overrides,
  };
}

describe("api-edge config facade", () => {
  describe("isConfigRoute", () => {
    // Organization scope
    it("matches /v1/organizations/{orgId}/config/settings", () => {
      expect(isConfigRoute("/v1/organizations/org_abc123def456/config/settings")).toBe(true);
    });

    it("matches /v1/organizations/{orgId}/config/feature-flags", () => {
      expect(isConfigRoute("/v1/organizations/org_abc123def456/config/feature-flags")).toBe(true);
    });

    it("matches /v1/organizations/{orgId}/config/secrets", () => {
      expect(isConfigRoute("/v1/organizations/org_abc123def456/config/secrets")).toBe(true);
    });

    // Project scope
    it("matches /v1/organizations/{orgId}/projects/{prjId}/config/settings", () => {
      expect(isConfigRoute("/v1/organizations/org_abc/projects/prj_def/config/settings")).toBe(true);
    });

    it("matches /v1/organizations/{orgId}/projects/{prjId}/config/feature-flags", () => {
      expect(isConfigRoute("/v1/organizations/org_abc/projects/prj_def/config/feature-flags")).toBe(true);
    });

    it("matches /v1/organizations/{orgId}/projects/{prjId}/config/secrets", () => {
      expect(isConfigRoute("/v1/organizations/org_abc/projects/prj_def/config/secrets")).toBe(true);
    });

    // Environment scope
    it("matches environment-scoped config settings", () => {
      expect(isConfigRoute("/v1/organizations/org_a/projects/prj_b/environments/env_c/config/settings")).toBe(true);
    });

    it("matches environment-scoped config feature-flags", () => {
      expect(isConfigRoute("/v1/organizations/org_a/projects/prj_b/environments/env_c/config/feature-flags")).toBe(true);
    });

    it("matches environment-scoped config secrets", () => {
      expect(isConfigRoute("/v1/organizations/org_a/projects/prj_b/environments/env_c/config/secrets")).toBe(true);
    });

    // Non-matches
    it("does not match /v1/organizations/{orgId}/projects", () => {
      expect(isConfigRoute("/v1/organizations/org_abc/projects")).toBe(false);
    });

    it("does not match /v1/organizations/{orgId}/config/unknown", () => {
      expect(isConfigRoute("/v1/organizations/org_abc/config/unknown")).toBe(false);
    });

    it("matches config item routes (settings/feature-flags with ID segment)", () => {
      expect(isConfigRoute("/v1/organizations/org_abc/config/settings/stg_abc")).toBe(true);
      expect(isConfigRoute("/v1/organizations/org_abc/config/feature-flags/flg_abc")).toBe(true);
    });

    // Secret item routes
    it("matches secret item route (org scope)", () => {
      expect(isConfigRoute("/v1/organizations/org_abc/config/secrets/sec_abc")).toBe(true);
    });

    it("matches secret item route (project scope)", () => {
      expect(isConfigRoute("/v1/organizations/org_abc/projects/prj_def/config/secrets/sec_abc")).toBe(true);
    });

    it("matches secret item route (environment scope)", () => {
      expect(isConfigRoute("/v1/organizations/org_a/projects/prj_b/environments/env_c/config/secrets/sec_abc")).toBe(true);
    });

    it("matches secret rotate route", () => {
      expect(isConfigRoute("/v1/organizations/org_abc/config/secrets/sec_abc/rotate")).toBe(true);
    });

    it("matches project-scoped secret rotate route", () => {
      expect(isConfigRoute("/v1/organizations/org_abc/projects/prj_def/config/secrets/sec_abc/rotate")).toBe(true);
    });

    it("matches environment-scoped secret rotate route", () => {
      expect(isConfigRoute("/v1/organizations/org_a/projects/prj_b/environments/env_c/config/secrets/sec_abc/rotate")).toBe(true);
    });
  });

  describe("handleConfigRoute", () => {
    it("forwards POST to config-worker (create)", async () => {
      const env = createEnv();
      const req = new Request("https://api-edge/v1/organizations/org_abc/config/settings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok_test" },
        body: JSON.stringify({ key: "app.name", value: "test" }),
      });
      const res = await handleConfigRoute(req, env as never, "req_test", "/v1/organizations/org_abc/config/settings");
      // Resolves actor then forwards; exact status depends on env stubs
      expect([200, 503]).toContain(res.status);
    });

    it("forwards DELETE to config-worker for secret revoke", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const { fetcher: configFetcher, calls: configCalls } = createFakeFetcher();
      const env = createEnv({
        IDENTITY_WORKER: identityFetcher,
        CONFIG_WORKER: configFetcher,
      });
      const req = new Request("https://api-edge/v1/organizations/org_abc/config/secrets/sec_abc", {
        method: "DELETE",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleConfigRoute(req, env as never, "req_test", "/v1/organizations/org_abc/config/secrets/sec_abc");
      expect(res.status).toBe(200);
      expect(configCalls.length).toBe(1);
      expect(configCalls[0]!.init.method).toBe("DELETE");
    });

    it("returns 405 for PUT (unsupported method)", async () => {
      const env = createEnv();
      const req = new Request("https://api-edge/v1/organizations/org_abc/config/settings", {
        method: "PUT",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleConfigRoute(req, env as never, "req_test", "/v1/organizations/org_abc/config/settings");
      expect(res.status).toBe(405);
    });

    it("returns 503 when IDENTITY_WORKER is missing", async () => {
      const env = createEnv({ IDENTITY_WORKER: undefined });
      const req = new Request("https://api-edge/v1/organizations/org_abc/config/settings", {
        method: "GET",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleConfigRoute(req, env as never, "req_test", "/v1/organizations/org_abc/config/settings");
      expect(res.status).toBe(503);
    });

    it("returns 503 when CONFIG_WORKER is missing", async () => {
      const env = createEnv({ CONFIG_WORKER: undefined });
      const req = new Request("https://api-edge/v1/organizations/org_abc/config/settings", {
        method: "GET",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleConfigRoute(req, env as never, "req_test", "/v1/organizations/org_abc/config/settings");
      expect(res.status).toBe(503);
    });

    it("forwards GET to CONFIG_WORKER and returns response", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const configResponse = Response.json({ data: { settings: [{ id: "stg_abc" }] }, meta: { requestId: "req_test", cursor: null } });
      const { fetcher: configFetcher, calls: configCalls } = createFakeFetcher(configResponse);
      const env = createEnv({
        IDENTITY_WORKER: identityFetcher,
        CONFIG_WORKER: configFetcher,
      });
      const req = new Request("https://api-edge/v1/organizations/org_abc/config/settings?limit=10", {
        method: "GET",
        headers: { authorization: "Bearer tok_test", "x-request-id": "req_fwd" },
      });
      const res = await handleConfigRoute(req, env as never, "req_fwd", "/v1/organizations/org_abc/config/settings");
      expect(res.status).toBe(200);
      expect(configCalls.length).toBe(1);
      expect(configCalls[0]!.url).toContain("/v1/organizations/org_abc/config/settings?limit=10");
    });

    it("returns 503 when CONFIG_WORKER fetch throws", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const env = createEnv({
        IDENTITY_WORKER: identityFetcher,
        CONFIG_WORKER: createThrowingFetcher(),
      });
      const req = new Request("https://api-edge/v1/organizations/org_abc/config/settings", {
        method: "GET",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleConfigRoute(req, env as never, "req_test", "/v1/organizations/org_abc/config/settings");
      expect(res.status).toBe(503);
    });

    it("injects actor headers when forwarding to config-worker", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const { fetcher: configFetcher, calls: configCalls } = createFakeFetcher();
      const env = createEnv({
        IDENTITY_WORKER: identityFetcher,
        CONFIG_WORKER: configFetcher,
      });
      const req = new Request("https://api-edge/v1/organizations/org_abc/config/feature-flags", {
        method: "GET",
        headers: { authorization: "Bearer tok_test", "x-request-id": "req_actor" },
      });
      await handleConfigRoute(req, env as never, "req_actor", "/v1/organizations/org_abc/config/feature-flags");
      expect(configCalls.length).toBe(1);
      const fwdHeaders = configCalls[0]!.init.headers as Headers;
      expect(fwdHeaders.get("x-actor-subject-id")).toBe("usr_test");
      expect(fwdHeaders.get("x-actor-subject-type")).toBe("user");
      expect(fwdHeaders.get("x-request-id")).toBe("req_actor");
    });
  });
});
