import { isAuditRoute, handleAuditRoute } from "@api-edge/audit-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({ data: { auditEntries: [] }, meta: { requestId: "req_test", cursor: null } }),
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
      return Promise.resolve(Response.json({ data: { auditEntries: [] }, meta: { requestId: "req_test", cursor: null } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createEnv(overrides?: Record<string, unknown>) {
  const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
  const { fetcher: eventsFetcher } = createFakeFetcher();
  return {
    IDENTITY_WORKER: identityFetcher,
    EVENTS_WORKER: eventsFetcher,
    MEMBERSHIP_WORKER: createFakeFetcher().fetcher,
    PROJECTS_WORKER: createFakeFetcher().fetcher,
    ENVIRONMENT: "test",
    ...overrides,
  };
}

describe("api-edge audit facade", () => {
  describe("isAuditRoute", () => {
    it("matches /v1/organizations/{orgId}/audit", () => {
      expect(isAuditRoute("/v1/organizations/org_abc123def456/audit")).toBe(true);
    });

    it("does not match /v1/organizations/{orgId}/audit/extra", () => {
      expect(isAuditRoute("/v1/organizations/org_abc/audit/extra")).toBe(false);
    });

    it("does not match /v1/organizations/{orgId}/members", () => {
      expect(isAuditRoute("/v1/organizations/org_abc/members")).toBe(false);
    });

    it("does not match /v1/organizations/{orgId}/projects", () => {
      expect(isAuditRoute("/v1/organizations/org_abc/projects")).toBe(false);
    });
  });

  describe("handleAuditRoute", () => {
    it("returns 405 for non-GET methods", async () => {
      const env = createEnv();
      const req = new Request("https://api.test/v1/organizations/org_abc/audit", {
        method: "POST",
        headers: { authorization: "Bearer token123" },
      });
      const res = await handleAuditRoute(req, env as any, "req_test", "/v1/organizations/org_abc/audit");
      expect(res.status).toBe(405);
    });

    it("returns 503 when IDENTITY_WORKER is missing", async () => {
      const env = createEnv({ IDENTITY_WORKER: undefined });
      const req = new Request("https://api.test/v1/organizations/org_abc/audit", {
        method: "GET",
        headers: { authorization: "Bearer token123" },
      });
      const res = await handleAuditRoute(req, env as any, "req_test", "/v1/organizations/org_abc/audit");
      expect(res.status).toBe(503);
    });

    it("returns 503 when EVENTS_WORKER is missing", async () => {
      const env = createEnv({ EVENTS_WORKER: undefined });
      const req = new Request("https://api.test/v1/organizations/org_abc/audit", {
        method: "GET",
        headers: { authorization: "Bearer token123" },
      });
      const res = await handleAuditRoute(req, env as any, "req_test", "/v1/organizations/org_abc/audit");
      expect(res.status).toBe(503);
    });

    it("returns 401 when no authorization header", async () => {
      const env = createEnv();
      const req = new Request("https://api.test/v1/organizations/org_abc/audit", {
        method: "GET",
      });
      const res = await handleAuditRoute(req, env as any, "req_test", "/v1/organizations/org_abc/audit");
      expect(res.status).toBe(401);
    });

    it("forwards to EVENTS_WORKER with actor headers after session resolution", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: eventsFetcher, calls: eventsCalls } = createFakeFetcher();
      const env = {
        IDENTITY_WORKER: identityFetcher,
        EVENTS_WORKER: eventsFetcher,
        ENVIRONMENT: "test",
      };

      const req = new Request("https://api.test/v1/organizations/org_abc/audit?limit=10&category=membership", {
        method: "GET",
        headers: {
          authorization: "Bearer token123",
          traceparent: "00-trace-span-01",
          "idempotency-key": "idem-123",
        },
      });

      const res = await handleAuditRoute(req, env as any, "req_test", "/v1/organizations/org_abc/audit");
      expect(res.status).toBe(200);

      expect(eventsCalls).toHaveLength(1);
      const call = eventsCalls[0]!;
      expect(call.url).toContain("/v1/organizations/org_abc/audit?limit=10&category=membership");
      const h = call.init.headers as Headers;
      expect(h.get("x-actor-subject-id")).toBe("usr_abc123");
      expect(h.get("x-actor-subject-type")).toBe("user");
      expect(h.get("x-actor-email")).toBe("user@test.com");
      expect(h.get("x-request-id")).toBe("req_test");
      expect(h.get("traceparent")).toBe("00-trace-span-01");
      expect(h.get("idempotency-key")).toBe("idem-123");
    });

    it("does not forward bearer token to EVENTS_WORKER", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: eventsFetcher, calls: eventsCalls } = createFakeFetcher();
      const env = {
        IDENTITY_WORKER: identityFetcher,
        EVENTS_WORKER: eventsFetcher,
        ENVIRONMENT: "test",
      };

      const req = new Request("https://api.test/v1/organizations/org_abc/audit", {
        method: "GET",
        headers: { authorization: "Bearer secret-token" },
      });

      await handleAuditRoute(req, env as any, "req_test", "/v1/organizations/org_abc/audit");

      const h = eventsCalls[0]!.init.headers as Headers;
      expect(h.get("authorization")).toBeNull();
    });

    it("does not forward body for GET", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: eventsFetcher, calls: eventsCalls } = createFakeFetcher();
      const env = {
        IDENTITY_WORKER: identityFetcher,
        EVENTS_WORKER: eventsFetcher,
        ENVIRONMENT: "test",
      };

      const req = new Request("https://api.test/v1/organizations/org_abc/audit", {
        method: "GET",
        headers: { authorization: "Bearer token123" },
      });

      await handleAuditRoute(req, env as any, "req_test", "/v1/organizations/org_abc/audit");

      expect(eventsCalls[0]!.init.body).toBeUndefined();
    });

    it("returns 503 when EVENTS_WORKER fetch throws", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const env = {
        IDENTITY_WORKER: identityFetcher,
        EVENTS_WORKER: createThrowingFetcher(),
        ENVIRONMENT: "test",
      };

      const req = new Request("https://api.test/v1/organizations/org_abc/audit", {
        method: "GET",
        headers: { authorization: "Bearer token123" },
      });

      const res = await handleAuditRoute(req, env as any, "req_test", "/v1/organizations/org_abc/audit");
      expect(res.status).toBe(503);
    });
  });
});
