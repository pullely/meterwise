import {
  isIntegrationsRoute,
  isIntegrationsIngressRoute,
  handleIntegrationsRoute,
  handleIntegrationsIngressRoute,
} from "@api-edge/integrations-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({
    data: { connections: [], nextCursor: null },
    meta: { requestId: "req_test", cursor: null },
  }),
): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(response.clone());
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createSessionFetcher(userId: string): Fetcher {
  return {
    fetch(input: string | Request | URL): Promise<Response> {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
      return Promise.resolve(Response.json({ data: {}, meta: { requestId: "req_x", cursor: null } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

const ORG_PATH = "/v1/organizations/org_11111111111111111111111111111111/integrations";

function createEnv(overrides?: Record<string, unknown>) {
  const { fetcher: integrationsFetcher, calls } = createFakeFetcher();
  return {
    env: {
      IDENTITY_WORKER: createSessionFetcher("usr_abc123"),
      INTEGRATIONS_WORKER: integrationsFetcher,
      ENVIRONMENT: "test",
      ...overrides,
    },
    calls,
  };
}

describe("integrations facade — route matching", () => {
  it("matches org integration routes", () => {
    expect(isIntegrationsRoute(ORG_PATH)).toBe(true);
    expect(isIntegrationsRoute(`${ORG_PATH}/github/connect`)).toBe(true);
    expect(isIntegrationsRoute(`${ORG_PATH}/int_abc`)).toBe(true);
    expect(isIntegrationsRoute("/v1/organizations/org_x/webhooks/endpoints")).toBe(false);
    expect(isIntegrationsRoute("/v1/integrations")).toBe(false);
  });

  it("matches project repo-link routes (IG3) but not other project routes", () => {
    expect(isIntegrationsRoute("/v1/organizations/org_x/projects/prj_y/repo-links")).toBe(true);
    expect(isIntegrationsRoute("/v1/organizations/org_x/projects/prj_y/repo-links/repl_z")).toBe(true);
    expect(isIntegrationsRoute("/v1/organizations/org_x/projects/prj_y/environments")).toBe(false);
    expect(isIntegrationsRoute("/v1/organizations/org_x/projects/prj_y")).toBe(false);
  });

  it("matches exactly the two allowlisted ingress paths", () => {
    expect(isIntegrationsIngressRoute("/ingress/github/setup")).toBe(true);
    expect(isIntegrationsIngressRoute("/ingress/github/webhook")).toBe(true);
    expect(isIntegrationsIngressRoute("/ingress/github/setup/extra")).toBe(false);
    expect(isIntegrationsIngressRoute("/ingress/github/other")).toBe(false);
  });
});

describe("integrations facade — authenticated surface", () => {
  it("rejects unsupported methods", async () => {
    const { env } = createEnv();
    const res = await handleIntegrationsRoute(
      new Request(`https://edge.test${ORG_PATH}`, { method: "PUT" }),
      env as never,
      "req_1",
      ORG_PATH,
    );
    expect(res.status).toBe(405);
  });

  it("401s without a bearer token", async () => {
    const { env, calls } = createEnv();
    const res = await handleIntegrationsRoute(
      new Request(`https://edge.test${ORG_PATH}`, { method: "GET" }),
      env as never,
      "req_1",
      ORG_PATH,
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("forwards with pinned x-actor headers and preserves path + query", async () => {
    const { env, calls } = createEnv();
    const res = await handleIntegrationsRoute(
      new Request(`https://edge.test${ORG_PATH}?limit=10`, {
        method: "GET",
        headers: { authorization: "Bearer tok_123" },
      }),
      env as never,
      "req_1",
      ORG_PATH,
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const target = new URL(calls[0]!.url);
    expect(target.pathname).toBe(ORG_PATH);
    expect(target.searchParams.get("limit")).toBe("10");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("x-actor-subject-id")).toBe("usr_abc123");
    expect(headers.get("x-actor-subject-type")).toBe("user");
    expect(headers.get("x-request-id")).toBe("req_1");
  });

  it("503s when the integrations binding is missing", async () => {
    const { env } = createEnv({ INTEGRATIONS_WORKER: undefined });
    const res = await handleIntegrationsRoute(
      new Request(`https://edge.test${ORG_PATH}`, {
        method: "GET",
        headers: { authorization: "Bearer tok_123" },
      }),
      env as never,
      "req_1",
      ORG_PATH,
    );
    expect(res.status).toBe(503);
  });
});

describe("integrations facade — public setup ingress", () => {
  const INGRESS = "/ingress/github/setup?installation_id=99&state=abc.def";

  it("forwards GET with the full query string and no session requirement", async () => {
    const { env, calls } = createEnv();
    const res = await handleIntegrationsIngressRoute(
      new Request(`https://edge.test${INGRESS}`, { method: "GET" }),
      env as never,
      "req_1",
      "/ingress/github/setup",
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const target = new URL(calls[0]!.url);
    expect(target.pathname).toBe("/ingress/github/setup");
    expect(target.searchParams.get("installation_id")).toBe("99");
    expect(target.searchParams.get("state")).toBe("abc.def");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("x-internal-caller")).toBe("api-edge");
    // Never any actor headers on the bearer-less surface.
    expect(headers.get("x-actor-subject-id")).toBeNull();
  });

  it("rejects non-GET methods", async () => {
    const { env, calls } = createEnv();
    const res = await handleIntegrationsIngressRoute(
      new Request("https://edge.test/ingress/github/setup", { method: "POST" }),
      env as never,
      "req_1",
      "/ingress/github/setup",
    );
    expect(res.status).toBe(405);
    expect(calls).toHaveLength(0);
  });
});

describe("integrations facade — public webhook ingress", () => {
  it("streams the raw body with the signature headers, no session required", async () => {
    const { env, calls } = createEnv();
    const res = await handleIntegrationsIngressRoute(
      new Request("https://edge.test/ingress/github/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": "gh-uuid-1",
          "x-github-event": "push",
          "x-hub-signature-256": "sha256=abc",
        },
        body: JSON.stringify({ zen: "Keep it logically awesome." }),
      }),
      env as never,
      "req_1",
      "/ingress/github/webhook",
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("x-github-delivery")).toBe("gh-uuid-1");
    expect(headers.get("x-github-event")).toBe("push");
    expect(headers.get("x-hub-signature-256")).toBe("sha256=abc");
    expect(headers.get("x-internal-caller")).toBe("api-edge");
    expect(headers.get("x-actor-subject-id")).toBeNull();
    // Raw body forwarded as a stream, not re-serialized.
    expect(calls[0]!.init.body).toBeTruthy();
  });

  it("rejects non-POST on the webhook path", async () => {
    const { env, calls } = createEnv();
    const res = await handleIntegrationsIngressRoute(
      new Request("https://edge.test/ingress/github/webhook", { method: "GET" }),
      env as never,
      "req_1",
      "/ingress/github/webhook",
    );
    expect(res.status).toBe(405);
    expect(calls).toHaveLength(0);
  });
});
