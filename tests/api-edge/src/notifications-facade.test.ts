import { isNotificationsRoute, handleNotificationsRoute } from "@api-edge/notifications-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({
    data: { preferences: [] },
    meta: { requestId: "req_test", cursor: null },
  }),
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
              session: { id: "ses_abc" },
              user: { id: userId, email: "user@test.com", displayName: "Test" },
            },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(
        Response.json({ data: { preferences: [] }, meta: { requestId: "req_test", cursor: null } }),
      );
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createEnv(overrides?: Record<string, unknown>) {
  const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
  const { fetcher: notificationsFetcher } = createFakeFetcher();
  return {
    IDENTITY_WORKER: identityFetcher,
    NOTIFICATIONS_WORKER: notificationsFetcher,
    ENVIRONMENT: "test",
    ...overrides,
  };
}

const PATH = "/v1/notifications/preferences";

describe("api-edge notifications facade", () => {
  describe("isNotificationsRoute", () => {
    it("matches the preferences path exactly", () => {
      expect(isNotificationsRoute(PATH)).toBe(true);
    });
    it("does not match other notifications paths", () => {
      expect(isNotificationsRoute("/v1/notifications")).toBe(false);
      expect(isNotificationsRoute("/v1/notifications/ntf_123")).toBe(false);
      expect(isNotificationsRoute(`${PATH}/extra`)).toBe(false);
    });
  });

  describe("handleNotificationsRoute", () => {
    it("returns 405 for POST", async () => {
      const req = new Request(`https://api.test${PATH}`, {
        method: "POST",
        headers: { authorization: "Bearer token123" },
      });
      const res = await handleNotificationsRoute(req, createEnv() as never, "req_test", PATH);
      expect(res.status).toBe(405);
    });

    it("returns 503 when NOTIFICATIONS_WORKER is missing", async () => {
      const env = createEnv({ NOTIFICATIONS_WORKER: undefined });
      const req = new Request(`https://api.test${PATH}`, {
        method: "GET",
        headers: { authorization: "Bearer token123" },
      });
      const res = await handleNotificationsRoute(req, env as never, "req_test", PATH);
      expect(res.status).toBe(503);
    });

    it("returns 401 when no authorization header", async () => {
      const req = new Request(`https://api.test${PATH}`, { method: "GET" });
      const res = await handleNotificationsRoute(req, createEnv() as never, "req_test", PATH);
      expect(res.status).toBe(401);
    });

    it("pins the GET subject to the resolved actor, ignoring caller-supplied subject params", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_me");
      const { fetcher: notificationsFetcher, calls } = createFakeFetcher();
      const env = {
        IDENTITY_WORKER: identityFetcher,
        NOTIFICATIONS_WORKER: notificationsFetcher,
        ENVIRONMENT: "test",
      };
      const req = new Request(
        `https://api.test${PATH}?orgId=org_abc&subjectKind=organization&subjectId=usr_victim`,
        { method: "GET", headers: { authorization: "Bearer token123" } },
      );
      const res = await handleNotificationsRoute(req, env as never, "req_test", PATH);
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      const url = new URL(calls[0]!.url);
      expect(url.searchParams.get("orgId")).toBe("org_abc");
      expect(url.searchParams.get("subjectKind")).toBe("user");
      expect(url.searchParams.get("subjectId")).toBe("usr_me");
      const headers = new Headers(calls[0]!.init.headers);
      expect(headers.get("x-internal-actor")).toBe("api-edge");
      expect(headers.get("x-actor-subject-id")).toBe("usr_me");
    });

    it("pins the PUT body subject to the resolved actor", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_me");
      const { fetcher: notificationsFetcher, calls } = createFakeFetcher(
        Response.json({
          data: { preference: {} },
          meta: { requestId: "req_test", cursor: null },
        }),
      );
      const env = {
        IDENTITY_WORKER: identityFetcher,
        NOTIFICATIONS_WORKER: notificationsFetcher,
        ENVIRONMENT: "test",
      };
      const req = new Request(`https://api.test${PATH}`, {
        method: "PUT",
        headers: { authorization: "Bearer token123", "content-type": "application/json" },
        body: JSON.stringify({
          orgId: "org_abc",
          subjectKind: "organization",
          subjectId: "usr_victim",
          channel: "email",
          categories: { billing: false },
        }),
      });
      const res = await handleNotificationsRoute(req, env as never, "req_test", PATH);
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
      expect(body.subjectKind).toBe("user");
      expect(body.subjectId).toBe("usr_me");
      expect(body.orgId).toBe("org_abc");
      expect(body.categories).toEqual({ billing: false });
    });

    it("rejects a non-JSON PUT body with 400", async () => {
      const req = new Request(`https://api.test${PATH}`, {
        method: "PUT",
        headers: { authorization: "Bearer token123" },
        body: "not-json",
      });
      const res = await handleNotificationsRoute(req, createEnv() as never, "req_test", PATH);
      expect(res.status).toBe(400);
    });
  });
});
