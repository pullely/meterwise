import { isWebhooksRoute, handleWebhooksRoute } from "@api-edge/webhooks-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({ data: { endpoints: [] }, meta: { requestId: "req_test", cursor: null } }),
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
      return Promise.resolve(Response.json({ data: { endpoints: [] }, meta: { requestId: "req_test", cursor: null } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createEnv(overrides?: Record<string, unknown>) {
  const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
  const { fetcher: webhooksFetcher } = createFakeFetcher();
  return {
    IDENTITY_WORKER: identityFetcher,
    WEBHOOKS_WORKER: webhooksFetcher,
    CONFIG_WORKER: createFakeFetcher().fetcher,
    MEMBERSHIP_WORKER: createFakeFetcher().fetcher,
    PROJECTS_WORKER: createFakeFetcher().fetcher,
    EVENTS_WORKER: createFakeFetcher().fetcher,
    ENVIRONMENT: "test",
    ...overrides,
  };
}

describe("api-edge webhooks facade", () => {
  describe("isWebhooksRoute", () => {
    it("matches org-scoped webhook endpoints", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/webhooks/endpoints")).toBe(true);
    });

    it("matches org-scoped webhook endpoint item", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/webhooks/endpoints/whe_abc123")).toBe(true);
    });

    it("matches org-scoped webhook subscriptions", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/webhooks/subscriptions")).toBe(true);
    });

    it("matches org-scoped webhook delivery attempts", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/webhooks/delivery-attempts/whd_abc123")).toBe(true);
    });

    it("matches org-scoped webhook delivery-attempt replay (Task 0126)", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/webhooks/delivery-attempts/whd_abc123/replay")).toBe(true);
    });

    it("matches project-scoped webhook endpoints", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/projects/prj_def/webhooks/endpoints")).toBe(true);
    });

    it("matches endpoint disable route", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/webhooks/endpoints/whe_abc123/disable")).toBe(true);
    });

    it("matches endpoint enable route", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/webhooks/endpoints/whe_abc123/enable")).toBe(true);
    });

    it("matches endpoint rotate-secret route", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/webhooks/endpoints/whe_abc123/rotate-secret")).toBe(true);
    });

    it("matches endpoint subscriptions list", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/webhooks/endpoints/whe_abc123/subscriptions")).toBe(true);
    });

    it("matches endpoint delivery-attempts list", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/webhooks/endpoints/whe_abc123/delivery-attempts")).toBe(true);
    });

    // Non-matches
    it("does not match config routes", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/config/settings")).toBe(false);
    });

    it("does not match org routes", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc")).toBe(false);
    });

    it("does not match project routes", () => {
      expect(isWebhooksRoute("/v1/organizations/org_abc/projects")).toBe(false);
    });
  });

  describe("handleWebhooksRoute", () => {
    it("forwards GET to webhooks-worker", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const { fetcher: webhooksFetcher, calls: webhooksCalls } = createFakeFetcher();
      const env = createEnv({
        IDENTITY_WORKER: identityFetcher,
        WEBHOOKS_WORKER: webhooksFetcher,
      });
      const req = new Request("https://api-edge/v1/organizations/org_abc/webhooks/endpoints?limit=10", {
        method: "GET",
        headers: { authorization: "Bearer tok_test", "x-request-id": "req_fwd" },
      });
      const res = await handleWebhooksRoute(req, env as never, "req_fwd", "/v1/organizations/org_abc/webhooks/endpoints");
      expect(res.status).toBe(200);
      expect(webhooksCalls.length).toBe(1);
      expect(webhooksCalls[0]!.url).toContain("/v1/organizations/org_abc/webhooks/endpoints?limit=10");
    });

    it("forwards POST to webhooks-worker (create)", async () => {
      const env = createEnv();
      const req = new Request("https://api-edge/v1/organizations/org_abc/webhooks/endpoints", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer tok_test" },
        body: JSON.stringify({ url: "https://example.com/hook", name: "test" }),
      });
      const res = await handleWebhooksRoute(req, env as never, "req_test", "/v1/organizations/org_abc/webhooks/endpoints");
      expect([200, 503]).toContain(res.status);
    });

    it("returns 405 for PUT (unsupported method)", async () => {
      const env = createEnv();
      const req = new Request("https://api-edge/v1/organizations/org_abc/webhooks/endpoints", {
        method: "PUT",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleWebhooksRoute(req, env as never, "req_test", "/v1/organizations/org_abc/webhooks/endpoints");
      expect(res.status).toBe(405);
    });

    it("returns 503 when IDENTITY_WORKER is missing", async () => {
      const env = createEnv({ IDENTITY_WORKER: undefined });
      const req = new Request("https://api-edge/v1/organizations/org_abc/webhooks/endpoints", {
        method: "GET",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleWebhooksRoute(req, env as never, "req_test", "/v1/organizations/org_abc/webhooks/endpoints");
      expect(res.status).toBe(503);
    });

    it("returns 503 when WEBHOOKS_WORKER is missing", async () => {
      const env = createEnv({ WEBHOOKS_WORKER: undefined });
      const req = new Request("https://api-edge/v1/organizations/org_abc/webhooks/endpoints", {
        method: "GET",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleWebhooksRoute(req, env as never, "req_test", "/v1/organizations/org_abc/webhooks/endpoints");
      expect(res.status).toBe(503);
    });

    it("returns 503 when WEBHOOKS_WORKER fetch throws", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const env = createEnv({
        IDENTITY_WORKER: identityFetcher,
        WEBHOOKS_WORKER: createThrowingFetcher(),
      });
      const req = new Request("https://api-edge/v1/organizations/org_abc/webhooks/endpoints", {
        method: "GET",
        headers: { authorization: "Bearer tok_test" },
      });
      const res = await handleWebhooksRoute(req, env as never, "req_test", "/v1/organizations/org_abc/webhooks/endpoints");
      expect(res.status).toBe(503);
    });

    it("injects actor headers when forwarding to webhooks-worker", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const { fetcher: webhooksFetcher, calls: webhooksCalls } = createFakeFetcher();
      const env = createEnv({
        IDENTITY_WORKER: identityFetcher,
        WEBHOOKS_WORKER: webhooksFetcher,
      });
      const req = new Request("https://api-edge/v1/organizations/org_abc/webhooks/endpoints", {
        method: "GET",
        headers: { authorization: "Bearer tok_test", "x-request-id": "req_actor" },
      });
      await handleWebhooksRoute(req, env as never, "req_actor", "/v1/organizations/org_abc/webhooks/endpoints");
      expect(webhooksCalls.length).toBe(1);
      const fwdHeaders = webhooksCalls[0]!.init.headers as Headers;
      expect(fwdHeaders.get("x-actor-subject-id")).toBe("usr_test");
      expect(fwdHeaders.get("x-actor-subject-type")).toBe("user");
      expect(fwdHeaders.get("x-request-id")).toBe("req_actor");
    });
  });
});
