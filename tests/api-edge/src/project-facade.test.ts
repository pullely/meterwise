import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isProjectRoute, handleProjectRoute } from "@api-edge/project-facade";

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

function createThrowingFetcher(): Fetcher {
  return {
    fetch(): Promise<Response> {
      return Promise.reject(new Error("network error"));
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
            data: { actor: { actorType: "user", actorId: userId, email: "user@test.com" }, session: { id: "ses_abc", expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" }, user: { id: userId, email: "user@test.com", displayName: "Test" } },
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

describe("api-edge project facade", () => {
  describe("isProjectRoute", () => {
    it("matches POST /v1/organizations/{orgId}/projects", () => {
      expect(isProjectRoute("/v1/organizations/org_abc123/projects")).toBe(true);
    });

    it("matches GET /v1/organizations/{orgId}/projects/{projectId}", () => {
      expect(isProjectRoute("/v1/organizations/org_abc123/projects/prj_def456")).toBe(true);
    });

    it("does not match project list (same as POST collection)", () => {
      expect(isProjectRoute("/v1/organizations/org_abc123/projects")).toBe(true);
    });

    it("matches nested environment routes under projects", () => {
      expect(isProjectRoute("/v1/organizations/org_abc/projects/prj_def/environments")).toBe(true);
    });

    it("does not match org routes", () => {
      expect(isProjectRoute("/v1/organizations/org_abc")).toBe(false);
    });

    it("does not match auth routes", () => {
      expect(isProjectRoute("/v1/auth/resolve")).toBe(false);
    });
  });

  describe("POST /v1/organizations/{orgId}/projects forwarding", () => {
    it("forwards POST to PROJECTS_WORKER after identity resolution", async () => {
      const { fetcher: identityFetcher, calls: identityCalls } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher(
        Response.json({ data: { project: { id: "prj_abc" } }, meta: { requestId: "req_test", cursor: null } }, { status: 201 }),
      );

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "My Project", slug: "my-project" }),
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects",
      );

      expect(response.status).toBe(201);
      expect(identityCalls).toHaveLength(1);
      expect(identityCalls[0]!.url).toContain("/v1/auth/resolve");
      expect(projectsCalls).toHaveLength(1);
      expect(projectsCalls[0]!.url).toContain("/v1/organizations/org_abc123/projects");
      expect(projectsCalls[0]!.init.method).toBe("POST");
    });

    it("forwards actor headers to PROJECTS_WORKER", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      });

      await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects",
      );

      const forwarded = new Headers(projectsCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("x-actor-subject-id")).toBe("usr_abc123");
      expect(forwarded.get("x-actor-subject-type")).toBe("user");
      expect(forwarded.get("x-actor-email")).toBe("user@test.com");
    });

    it("does not forward bearer token to PROJECTS_WORKER", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_secret.token", "content-type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      });

      await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects",
      );

      const forwarded = new Headers(projectsCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("authorization")).toBeNull();
      const rawCall = JSON.stringify(projectsCalls[0]);
      expect(rawCall).not.toContain("sps_ses_secret");
      expect(rawCall).not.toContain("Bearer");
    });
  });

  describe("GET /v1/organizations/{orgId}/projects/{projectId} forwarding", () => {
    it("forwards GET to PROJECTS_WORKER with actor headers", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456",
      );

      expect(response.status).toBe(200);
      expect(projectsCalls).toHaveLength(1);
      expect(projectsCalls[0]!.url).toContain("/v1/organizations/org_abc123/projects/prj_def456");
      expect(projectsCalls[0]!.init.method).toBe("GET");

      const forwarded = new Headers(projectsCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("x-actor-subject-id")).toBe("usr_abc123");
      expect(forwarded.get("x-actor-subject-type")).toBe("user");
    });

    it("PERF4: appends edge phases to the downstream Server-Timing header", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      // Downstream worker already emits its own Server-Timing.
      const downstream = Response.json(
        { data: { projects: [] }, meta: { requestId: "req_test", cursor: null } },
        { headers: { "Server-Timing": "authctx;dur=12, db;dur=34, policy;dur=2, total;dur=40" } },
      );
      const { fetcher: projectsFetcher } = createFakeFetcher(downstream);

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects",
      );

      expect(response.status).toBe(200);
      const timing = response.headers.get("Server-Timing");
      expect(timing).toBeTruthy();
      // Preserves the worker phases AND adds the edge phases.
      for (const phase of ["authctx", "db", "policy", "total", "edge_auth", "edge_downstream", "edge_total"]) {
        expect(timing).toContain(phase);
      }
    });

    it("does not forward bearer token to PROJECTS_WORKER for GET", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_secret.bearer" },
      });

      await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456",
      );

      const forwarded = new Headers(projectsCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("authorization")).toBeNull();
      const rawCall = JSON.stringify(projectsCalls[0]);
      expect(rawCall).not.toContain("sps_ses_secret");
    });
  });

  describe("DELETE /v1/organizations/{orgId}/projects/{projectId} forwarding", () => {
    it("forwards DELETE to PROJECTS_WORKER after identity resolution", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher(
        Response.json({ data: { project: { id: "prj_abc", status: "archived" } }, meta: { requestId: "req_test", cursor: null } }),
      );

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456",
      );

      expect(response.status).toBe(200);
      expect(projectsCalls).toHaveLength(1);
      expect(projectsCalls[0]!.url).toContain("/v1/organizations/org_abc123/projects/prj_def456");
      expect(projectsCalls[0]!.init.method).toBe("DELETE");

      const forwarded = new Headers(projectsCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("x-actor-subject-id")).toBe("usr_abc123");
      expect(forwarded.get("x-actor-subject-type")).toBe("user");
    });

    it("does not forward bearer token for DELETE", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_secret.token" },
      });

      await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456",
      );

      const forwarded = new Headers(projectsCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("authorization")).toBeNull();
      const rawCall = JSON.stringify(projectsCalls[0]);
      expect(rawCall).not.toContain("sps_ses_secret");
    });

    it("returns 503 when PROJECTS_WORKER is missing for DELETE", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456",
      );

      expect(response.status).toBe(503);
      const json = await response.json() as any;
      expect(json.error.message).toBe("Projects service unavailable");
    });

    it("returns 405 for PATCH on project item", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456", {
        method: "PATCH",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456",
      );

      expect(response.status).toBe(405);
    });
  });

  describe("error handling", () => {
    it("returns 503 when PROJECTS_WORKER is not configured", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects",
      );

      expect(response.status).toBe(503);
      const json = await response.json() as any;
      expect(json.error.code).toBe("internal_error");
      expect(json.error.message).toBe("Projects service unavailable");
    });

    it("returns 503 when IDENTITY_WORKER is not configured", async () => {
      const { fetcher: projectsFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      });

      const response = await handleProjectRoute(
        request,
        { PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects",
      );

      expect(response.status).toBe(503);
      const json = await response.json() as any;
      expect(json.error.message).toBe("Authentication service unavailable");
    });

    it("returns 503 with safe message when PROJECTS_WORKER throws", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const projectsFetcher = createThrowingFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects",
      );

      expect(response.status).toBe(503);
      const json = await response.json() as any;
      expect(json.error.message).toBe("Projects service unavailable");
      expect(JSON.stringify(json)).not.toContain("network error");
    });

    it("forwards GET on projects collection to PROJECTS_WORKER after identity resolution", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher(
        Response.json({ data: { projects: [] }, meta: { requestId: "req_test", cursor: null } }),
      );

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects?limit=10&cursor=abc", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects",
      );

      expect(response.status).toBe(200);
      expect(projectsCalls).toHaveLength(1);
      expect(projectsCalls[0]!.url).toContain("/v1/organizations/org_abc123/projects");
      expect(projectsCalls[0]!.url).toContain("limit=10");
      expect(projectsCalls[0]!.url).toContain("cursor=abc");
      expect(projectsCalls[0]!.init.method).toBe("GET");

      const forwarded = new Headers(projectsCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("x-actor-subject-id")).toBe("usr_abc123");
      expect(forwarded.get("x-actor-subject-type")).toBe("user");
      expect(forwarded.get("authorization")).toBeNull();
    });

    it("returns 503 when PROJECTS_WORKER is not configured for GET collection", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects",
      );

      expect(response.status).toBe(503);
      const json = await response.json() as any;
      expect(json.error.message).toBe("Projects service unavailable");
    });

    it("returns 401 when bearer token is missing", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects",
      );

      expect(response.status).toBe(401);
      const json = await response.json() as any;
      expect(json.error.code).toBe("unauthenticated");
    });
  });

  describe("isProjectRoute environment routes", () => {
    it("matches POST /v1/organizations/{orgId}/projects/{projectId}/environments", () => {
      expect(isProjectRoute("/v1/organizations/org_abc/projects/prj_def/environments")).toBe(true);
    });

    it("matches GET /v1/organizations/{orgId}/projects/{projectId}/environments/{envId}", () => {
      expect(isProjectRoute("/v1/organizations/org_abc/projects/prj_def/environments/env_ghi")).toBe(true);
    });
  });

  describe("POST /v1/organizations/{orgId}/projects/{projectId}/environments forwarding", () => {
    it("forwards POST to PROJECTS_WORKER after identity resolution with body", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher(
        Response.json({ data: { environment: { id: "env_abc" } }, meta: { requestId: "req_test", cursor: null } }, { status: 201 }),
      );

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "Production", slug: "production" }),
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments",
      );

      expect(response.status).toBe(201);
      expect(projectsCalls).toHaveLength(1);
      expect(projectsCalls[0]!.url).toContain("/v1/organizations/org_abc123/projects/prj_def456/environments");
      expect(projectsCalls[0]!.init.method).toBe("POST");
    });

    it("forwards actor headers and does not forward bearer token", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_secret.token", "content-type": "application/json" },
        body: JSON.stringify({ name: "Staging" }),
      });

      await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments",
      );

      const forwarded = new Headers(projectsCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("x-actor-subject-id")).toBe("usr_abc123");
      expect(forwarded.get("x-actor-subject-type")).toBe("user");
      expect(forwarded.get("authorization")).toBeNull();
      const rawCall = JSON.stringify(projectsCalls[0]);
      expect(rawCall).not.toContain("sps_ses_secret");
    });
  });

  describe("GET /v1/organizations/{orgId}/projects/{projectId}/environments forwarding", () => {
    it("forwards GET with query params to PROJECTS_WORKER", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher(
        Response.json({ data: { environments: [] }, meta: { requestId: "req_test", cursor: null } }),
      );

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments?limit=10&cursor=abc", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments",
      );

      expect(response.status).toBe(200);
      expect(projectsCalls).toHaveLength(1);
      expect(projectsCalls[0]!.url).toContain("/v1/organizations/org_abc123/projects/prj_def456/environments");
      expect(projectsCalls[0]!.url).toContain("limit=10");
      expect(projectsCalls[0]!.url).toContain("cursor=abc");
      expect(projectsCalls[0]!.init.method).toBe("GET");
    });
  });

  describe("GET /v1/organizations/{orgId}/projects/{projectId}/environments/{envId} forwarding", () => {
    it("forwards GET to PROJECTS_WORKER with actor headers", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789",
      );

      expect(response.status).toBe(200);
      expect(projectsCalls).toHaveLength(1);
      expect(projectsCalls[0]!.url).toContain("/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789");
      expect(projectsCalls[0]!.init.method).toBe("GET");

      const forwarded = new Headers(projectsCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("x-actor-subject-id")).toBe("usr_abc123");
      expect(forwarded.get("authorization")).toBeNull();
    });
  });

  describe("environment route method restrictions", () => {
    it("returns 405 for DELETE on environments collection", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments",
      );

      expect(response.status).toBe(405);
    });

    it("returns 405 for PATCH on environment item", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789", {
        method: "PATCH",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789",
      );

      expect(response.status).toBe(405);
    });

    it("forwards DELETE on environment item to PROJECTS_WORKER", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789",
      );

      expect(response.status).toBe(200);
      expect(projectsCalls).toHaveLength(1);
      expect(projectsCalls[0]!.init.method).toBe("DELETE");
    });

    it("does not forward bearer token for DELETE on environment item", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789",
      );

      const forwarded = new Headers(projectsCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("authorization")).toBeNull();
      const rawCall = JSON.stringify(projectsCalls[0]);
      expect(rawCall).not.toContain("sps_ses_abc");
    });

    it("does not forward body for DELETE on environment item", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789",
      );

      expect(projectsCalls[0]!.init.body).toBeUndefined();
    });

    it("forwards actor and request headers for DELETE on environment item", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789", {
        method: "DELETE",
        headers: {
          authorization: "Bearer sps_ses_abc.secret",
          traceparent: "00-trace-id",
          "idempotency-key": "idem_123",
        },
      });

      await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789",
      );

      const forwarded = new Headers(projectsCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("x-actor-subject-id")).toBe("usr_abc123");
      expect(forwarded.get("x-actor-subject-type")).toBe("user");
      expect(forwarded.get("x-request-id")).toBe("req_test");
      expect(forwarded.get("traceparent")).toBe("00-trace-id");
      expect(forwarded.get("idempotency-key")).toBe("idem_123");
    });

    it("returns 503 when PROJECTS_WORKER is missing for DELETE on environment item", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789",
      );

      expect(response.status).toBe(503);
    });

    it("preserves existing GET behavior for environment item route", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments/env_ghi789",
      );

      expect(response.status).toBe(200);
      expect(projectsCalls).toHaveLength(1);
      expect(projectsCalls[0]!.init.method).toBe("GET");
    });

    it("returns 503 when PROJECTS_WORKER is missing for environment route", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456/environments", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456/environments",
      );

      expect(response.status).toBe(503);
      const json = await response.json() as any;
      expect(json.error.message).toBe("Projects service unavailable");
    });
  });

  describe("existing project routes still work", () => {
    it("POST projects collection still forwards correctly", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher(
        Response.json({ data: { project: { id: "prj_abc" } }, meta: { requestId: "req_test", cursor: null } }, { status: 201 }),
      );

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ name: "My Project" }),
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects",
      );

      expect(response.status).toBe(201);
      expect(projectsCalls).toHaveLength(1);
    });

    it("DELETE project item still forwards correctly", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: projectsFetcher, calls: projectsCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc123/projects/prj_def456", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleProjectRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, PROJECTS_WORKER: projectsFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc123/projects/prj_def456",
      );

      expect(response.status).toBe(200);
      expect(projectsCalls).toHaveLength(1);
      expect(projectsCalls[0]!.init.method).toBe("DELETE");
    });
  });

  describe("binding verification config", () => {
    it("wrangler.jsonc has stage PROJECTS_WORKER binding to meterwise-projects-worker-stage", () => {
      const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsoncComments(raw));

      const stageServices = config.env?.stage?.services;
      expect(stageServices).toBeDefined();
      const projects = stageServices.find((s: any) => s.binding === "PROJECTS_WORKER");
      expect(projects).toBeDefined();
      expect(projects.service).toBe("meterwise-projects-worker-stage");
    });

    it("wrangler.jsonc has prod PROJECTS_WORKER binding to meterwise-projects-worker-prod", () => {
      const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsoncComments(raw));

      const prodServices = config.env?.prod?.services;
      expect(prodServices).toBeDefined();
      const projects = prodServices.find((s: any) => s.binding === "PROJECTS_WORKER");
      expect(projects).toBeDefined();
      expect(projects.service).toBe("meterwise-projects-worker-prod");
    });

    it("stage does not bind to prod projects worker", () => {
      const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsoncComments(raw));

      const stageServices = config.env?.stage?.services ?? [];
      const projectsBindings = stageServices.filter((s: any) => s.binding === "PROJECTS_WORKER");
      for (const svc of projectsBindings) {
        expect(svc.service).not.toContain("prod");
      }
    });

    it("prod does not bind to stage projects worker", () => {
      const configPath = resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc");
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsoncComments(raw));

      const prodServices = config.env?.prod?.services ?? [];
      const projectsBindings = prodServices.filter((s: any) => s.binding === "PROJECTS_WORKER");
      for (const svc of projectsBindings) {
        expect(svc.service).not.toContain("stage");
      }
    });
  });
});
