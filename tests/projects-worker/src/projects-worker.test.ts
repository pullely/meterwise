import { handleArchiveProject } from "@projects-worker/handlers/archive-project";
import { handleCreateProject } from "@projects-worker/handlers/create-project";
import { handleGetProject } from "@projects-worker/handlers/get-project";
import { handleListProjects } from "@projects-worker/handlers/list-projects";
import { handleCreateEnvironment } from "@projects-worker/handlers/create-environment";
import { handleListEnvironments } from "@projects-worker/handlers/list-environments";
import { handleGetEnvironment } from "@projects-worker/handlers/get-environment";
import { handleArchiveEnvironment } from "@projects-worker/handlers/archive-environment";
import { route } from "@projects-worker/router";
import type { Env } from "@projects-worker/env";
import type { ProjectsRepository, ProjectsResult, Project, CreateProjectInput, Environment, CreateEnvironmentInput } from "@saas/db/projects";
import type { EventsRepository, StoredEvent, StoredAuditEntry, AppendEventWithAuditInput } from "@saas/db/events";
import { asUuid } from "@saas/db/ids";

const TEST_ORG_UUID = asUuid("11111111-1111-1111-1111-111111111111");
const TEST_ORG_PUBLIC = "org_11111111111111111111111111111111";
const TEST_PROJECT_UUID = asUuid("22222222-2222-2222-2222-222222222222");
const TEST_PROJECT_PUBLIC = "prj_22222222222222222222222222222222";
const TEST_ENVIRONMENT_UUID = "33333333-3333-3333-3333-333333333333";
const TEST_ENVIRONMENT_PUBLIC = "env_33333333333333333333333333333333";
const TEST_USER_ID = "usr_aabbccdd";

type JsonResp = {
  data: {
    project: { id: string; orgId: string; name?: string };
    projects: Array<{ id: string; orgId: string; name?: string }>;
    environment: { id: string; orgId: string; projectId: string; name?: string };
    environments: Array<{ id: string; orgId: string; projectId: string; name?: string }>;
  };
  meta: { cursor: string | null };
  error: { code: string; message?: string };
};

function createMockFetcher(responseBody: unknown, status = 200): Fetcher & { fetchCalls: Array<{ url: string; init: RequestInit }> } {
  const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
  return {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url, init: init ?? {} });
      return Promise.resolve(new Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      }));
    },
    connect() { throw new Error("not implemented"); },
    fetchCalls,
  } as unknown as Fetcher & { fetchCalls: Array<{ url: string; init: RequestInit }> };
}

function createMockFetcherThatThrows(): Fetcher {
  return {
    fetch(): Promise<Response> {
      return Promise.reject(new Error("network error"));
    },
    connect() { throw new Error("not implemented"); },
  } as unknown as Fetcher;
}

function createFakeEnv(overrides?: Record<string, unknown>): Env {
  const base: Record<string, unknown> = {
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: createMockFetcher({ data: { memberships: [{ kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: TEST_ORG_UUID } }] } }),
    POLICY_WORKER: createMockFetcher({ data: { allow: true, reason: "org_admin", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    // Default: billing-worker returns an allowed `limit.projects` decision with
    // unlimited (limitValue: null) so legacy create-project tests keep passing.
    BILLING_WORKER: createMockFetcher({ data: { allowed: true, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.projects", valueType: "quantity", limitValue: null, source: "plan", subscriptionId: null } }),
    ENVIRONMENT: "test",
  };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete base[key];
      } else {
        base[key] = value;
      }
    }
  }
  return base as unknown as Env;
}

const fakeProject: Project = {
  id: TEST_PROJECT_UUID,
  orgId: TEST_ORG_UUID,
  name: "My Project",
  slug: "my-project",
  slugLower: "my-project",
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  archivedAt: null,
};

function createFakeProjectsRepo(overrides?: Partial<Record<keyof ProjectsRepository, unknown>>): ProjectsRepository & { createProjectCalls: unknown[][]; getProjectByIdCalls: unknown[][]; createEnvironmentCalls: unknown[][] } {
  const createProjectCalls: unknown[][] = [];
  const getProjectByIdCalls: unknown[][] = [];
  const createEnvironmentCalls: unknown[][] = [];

  const repo: ProjectsRepository & { createProjectCalls: unknown[][]; getProjectByIdCalls: unknown[][]; createEnvironmentCalls: unknown[][] } = {
    createProjectCalls,
    getProjectByIdCalls,
    createEnvironmentCalls,
    async createProject(input: CreateProjectInput): Promise<ProjectsResult<Project>> {
      createProjectCalls.push([input]);
      return { ok: true, value: { ...fakeProject, id: input.id, name: input.name, slug: input.slug, slugLower: input.slugLower } };
    },
    async getProjectById(orgId: string, projectId: string): Promise<ProjectsResult<Project>> {
      getProjectByIdCalls.push([orgId, projectId]);
      return { ok: true, value: fakeProject };
    },
    async getProjectBySlug() { return { ok: true, value: fakeProject }; },
    async listProjectsPaged() { return { ok: true, value: { items: [fakeProject], nextCursor: null } }; },
    async archiveProject() { return { ok: true, value: fakeProject }; },
    async countActiveProjects() { return { ok: true as const, value: 0 }; },
    async createEnvironment(input: unknown) {
      createEnvironmentCalls.push([input]);
      return { ok: false as const, error: { kind: "not_found" as const } };
    },
    async countActiveEnvironments() { return { ok: true as const, value: 0 }; },
    async getEnvironmentById() { return { ok: false as const, error: { kind: "not_found" as const } }; },
    async getEnvironmentBySlug() { return { ok: false as const, error: { kind: "not_found" as const } }; },
    async listEnvironmentsPaged() { return { ok: true, value: { items: [], nextCursor: null } }; },
    async archiveEnvironment() { return { ok: false as const, error: { kind: "not_found" as const } }; },
  };

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      (repo as unknown as Record<string, unknown>)[key] = value;
    }
  }

  return repo;
}

function createFakeEventsRepo(overrides?: Partial<Record<keyof EventsRepository, unknown>>): EventsRepository & { appendEventWithAuditCalls: unknown[][] } {
  const appendEventWithAuditCalls: unknown[][] = [];
  const fakeEvent: StoredEvent = {
    id: "event-id",
    type: "project.created",
    version: 1,
    source: "projects-worker",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    actorType: "user",
    actorId: TEST_USER_ID,
    actorSessionId: null,
    actorIp: null,
    orgId: TEST_ORG_UUID,
    projectId: TEST_PROJECT_UUID,
    environmentId: null,
    subjectKind: "project",
    subjectId: TEST_PROJECT_UUID,
    subjectName: "My Project",
    requestId: "req_test",
    correlationId: null,
    causationId: null,
    idempotencyKey: null,
    payload: {},
    redactPaths: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  const fakeAudit: StoredAuditEntry = {
    id: "audit-id",
    eventId: "event-id",
    orgId: TEST_ORG_UUID,
    projectId: TEST_PROJECT_UUID,
    environmentId: null,
    actorType: "user",
    actorId: TEST_USER_ID,
    eventType: "project.created",
    eventVersion: 1,
    source: "projects-worker",
    subjectKind: "project",
    subjectId: TEST_PROJECT_UUID,
    subjectName: "My Project",
    category: "projects",
    description: "Created project",
    occurredAt: new Date("2026-01-01T00:00:00Z"),
    requestId: "req_test",
    correlationId: null,
    payload: {},
    redactPaths: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };

  const repo: EventsRepository & { appendEventWithAuditCalls: unknown[][] } = {
    appendEventWithAuditCalls,
    async appendEvent() { return { ok: true, value: fakeEvent }; },
    async appendEventWithAudit(input: AppendEventWithAuditInput) {
      appendEventWithAuditCalls.push([input]);
      return { ok: true, value: { event: fakeEvent, audit: fakeAudit } };
    },
    async queryEventsByOrg() { return { ok: true, value: [] }; },
    async getEventById() { return { ok: true, value: null }; },
    async queryAuditByOrg() { return { ok: true, value: { items: [], nextCursor: null } }; },
    async queryAuditByTarget() { return { ok: true, value: { items: [], nextCursor: null } }; },
  };

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      (repo as unknown as Record<string, unknown>)[key] = value;
    }
  }

  return repo;
}

function makeRequest(method: string, path: string, body?: unknown, headers?: Record<string, string>): Request {
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      "x-request-id": "req_test123",
      "x-actor-subject-id": TEST_USER_ID,
      "x-actor-subject-type": "user",
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`https://projects-worker${path}`, init);
}

describe("projects-worker router", () => {
  it("returns health check", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", "/health", undefined, {});
    const res = await route(req, env);
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { service: string } };
    expect(json.data.service).toBe("projects-worker");
  });

  it("returns 404 for unknown routes", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", "/v1/unknown");
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 404 for malformed org public ID", async () => {
    const env = createFakeEnv();
    const req = makeRequest("POST", "/v1/organizations/bad_id/projects", { name: "test" });
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 404 for malformed project public ID", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/bad_id`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 401 for missing actor on POST projects", async () => {
    const env = createFakeEnv();
    const req = new Request(`https://projects-worker/v1/organizations/${TEST_ORG_PUBLIC}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 for missing actor on GET project", async () => {
    const env = createFakeEnv();
    const req = new Request(`https://projects-worker/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}`, {
      method: "GET",
    });
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 405 for unsupported methods on projects collection", async () => {
    const env = createFakeEnv();
    const req = makeRequest("DELETE", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 405 for unsupported methods on project item", async () => {
    const env = createFakeEnv();
    const req = makeRequest("PATCH", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 401 for missing actor on DELETE project", async () => {
    const env = createFakeEnv();
    const req = new Request(`https://projects-worker/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}`, {
      method: "DELETE",
    });
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });
});

describe("handleCreateProject", () => {
  it("creates a project with authorization and atomic event", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "My Project", slug: "my-project" });

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(201);

    const json = await res.json() as { data: { project: { id: string; orgId: string; name: string; slug: string } } };
    expect(json.data.project.name).toBe("My Project");
    expect(json.data.project.slug).toBe("my-project");
    expect(json.data.project.id).toMatch(/^prj_/);
    expect(json.data.project.orgId).toMatch(/^org_/);

    expect(projectsRepo.createProjectCalls.length).toBe(1);
    expect(eventsRepo.appendEventWithAuditCalls.length).toBe(1);
  });

  it("derives slug from name when slug is omitted", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Hello World" });

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(201);

    const call = projectsRepo.createProjectCalls[0]![0] as CreateProjectInput;
    expect(call.slug).toBe("hello-world");
    expect(call.slugLower).toBe("hello-world");
  });

  it("returns 422 for missing name", async () => {
    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, {});
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(422);
  });

  it("returns 422 for name too long", async () => {
    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "x".repeat(101) });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(422);
  });

  it("returns 422 for invalid slug format", async () => {
    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test", slug: "-bad-slug-" });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(422);
  });

  it("returns 422 for slug too short", async () => {
    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test", slug: "a" });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(422);
  });

  it("returns 422 for invalid JSON body", async () => {
    const env = createFakeEnv();
    const req = new Request("https://projects-worker/v1/organizations/x/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-actor-subject-id": TEST_USER_ID, "x-actor-subject-type": "user" },
      body: "not-json",
    });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(422);
  });

  it("returns 503 when PLATFORM_DB is missing", async () => {
    const env = createFakeEnv({ PLATFORM_DB: undefined });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test" });

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 when MEMBERSHIP_WORKER is missing", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: undefined });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test" });

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 when POLICY_WORKER is missing", async () => {
    const env = createFakeEnv({ POLICY_WORKER: undefined });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test" });

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID);
    expect(res.status).toBe(503);
  });

  it("fails closed when membership-context call fails", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcherThatThrows() });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test" });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when membership returns non-ok", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcher({}, 500) });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test" });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when membership returns malformed envelope", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcher({ something: "wrong" }) });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test" });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when policy denies", async () => {
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "denied", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test" });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
    expect(projectsRepo.createProjectCalls.length).toBe(0);
  });

  it("fails closed when policy-worker fetch throws", async () => {
    const env = createFakeEnv({ POLICY_WORKER: createMockFetcherThatThrows() });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test" });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
    expect(projectsRepo.createProjectCalls.length).toBe(0);
  });

  it("fails closed when policy returns malformed envelope", async () => {
    const env = createFakeEnv({ POLICY_WORKER: createMockFetcher({ wrong: "shape" }) });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test" });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
    expect(projectsRepo.createProjectCalls.length).toBe(0);
  });

  it("returns 409 on duplicate slug conflict", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      createProject: async () => ({ ok: false as const, error: { kind: "conflict" as const, entity: "project" } }),
    });
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test", slug: "existing" });

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(409);
  });

  it("rolls back when event append fails", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo({
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "db error" } }),
    });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test" });

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(503);
  });

  it("does not expose raw UUIDs in response", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test" });

    const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
    const text = await res.text();
    expect(text).not.toContain(TEST_ORG_UUID);
  });

  it("does not expose raw UUIDs in event payload", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Test" });

    await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });

    const eventCall = eventsRepo.appendEventWithAuditCalls[0]![0] as AppendEventWithAuditInput;
    const payload = eventCall.event.payload;
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain(TEST_ORG_UUID);
    expect(payload.projectId).toMatch(/^prj_/);
    expect(payload.orgId).toMatch(/^org_/);
  });

  // ── Billing entitlement gate (Task 0079) ──
  describe("billing entitlement gate (limit.projects)", () => {
    it("returns 503 when BILLING_WORKER binding is missing", async () => {
      const env = createFakeEnv({ BILLING_WORKER: undefined });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "X" });

      const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(503);
      // Must not have written anything.
      expect(projectsRepo.createProjectCalls.length).toBe(0);
      expect(eventsRepo.appendEventWithAuditCalls.length).toBe(0);
    });

    it("sends x-internal-caller=projects-worker on the billing service-binding call", async () => {
      const env = createFakeEnv();
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Hello" });

      const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(201);

      const billing = env.BILLING_WORKER as unknown as { fetchCalls: Array<{ url: string; init: RequestInit }> };
      expect(billing.fetchCalls.length).toBe(1);
      const call = billing.fetchCalls[0]!;
      expect(call.url).toContain("/v1/internal/billing/entitlements/check");
      const headers = call.init.headers as Record<string, string>;
      expect(headers["x-internal-caller"]).toBe("projects-worker");
      expect(headers["x-request-id"]).toBeTruthy();
      const sent = JSON.parse(call.init.body as string) as { orgId: string; entitlementKey: string };
      expect(sent.orgId).toBe(TEST_ORG_PUBLIC);
      expect(sent.entitlementKey).toBe("limit.projects");
    });

    it("allows creation when active count is strictly under the quantity limit", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: true, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.projects", valueType: "quantity", limitValue: 5, source: "plan", subscriptionId: null } }),
      });
      const projectsRepo = createFakeProjectsRepo({
        countActiveProjects: async () => ({ ok: true as const, value: 4 }),
      });
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Under Limit" });

      const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(201);
      expect(projectsRepo.createProjectCalls.length).toBe(1);
    });

    it("denies with 412 limit_reached when active count meets the quantity limit", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: true, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.projects", valueType: "quantity", limitValue: 3, source: "plan", subscriptionId: null } }),
      });
      const projectsRepo = createFakeProjectsRepo({
        countActiveProjects: async () => ({ ok: true as const, value: 3 }),
      });
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "At Limit" });

      const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(412);
      const json = await res.json() as { error: { code: string; details?: { reason?: string } } };
      expect(json.error.code).toBe("precondition_failed");
      expect(json.error.details?.reason).toBe("limit_reached");
      expect(projectsRepo.createProjectCalls.length).toBe(0);
      expect(eventsRepo.appendEventWithAuditCalls.length).toBe(0);
    });

    it("denies with 412 disabled when billing entitlement is disabled", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: false, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.projects", reason: "disabled" } }),
      });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Blocked" });

      const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(412);
      const json = await res.json() as { error: { code: string; details?: { reason?: string } } };
      expect(json.error.code).toBe("precondition_failed");
      expect(json.error.details?.reason).toBe("disabled");
      expect(projectsRepo.createProjectCalls.length).toBe(0);
    });

    it("denies with 412 not_configured when no entitlement exists for the org", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: false, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.projects", reason: "not_configured" } }),
      });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Blocked" });

      const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(412);
      const json = await res.json() as { error: { code: string; details?: { reason?: string } } };
      expect(json.error.code).toBe("precondition_failed");
      expect(json.error.details?.reason).toBe("not_configured");
    });

    it("returns 503 when billing-worker returns non-OK (fail-closed)", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({}, 500),
      });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "X" });

      const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(503);
      expect(projectsRepo.createProjectCalls.length).toBe(0);
    });

    it("returns 503 when billing-worker fetch throws (fail-closed)", async () => {
      const env = createFakeEnv({ BILLING_WORKER: createMockFetcherThatThrows() });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "X" });

      const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(503);
      expect(projectsRepo.createProjectCalls.length).toBe(0);
    });

    it("returns 503 when billing-worker returns malformed envelope (fail-closed)", async () => {
      const env = createFakeEnv({ BILLING_WORKER: createMockFetcher({ wrong: "shape" }) });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "X" });

      const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(503);
    });

    it("returns 503 when active-project count lookup fails (fail-closed)", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: true, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.projects", valueType: "quantity", limitValue: 5, source: "plan", subscriptionId: null } }),
      });
      const projectsRepo = createFakeProjectsRepo({
        countActiveProjects: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "boom" } }),
      });
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "X" });

      const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(503);
      expect(projectsRepo.createProjectCalls.length).toBe(0);
    });

    it("denies with 412 malformed_limit when billing returns a non-quantity valueType for limit.projects", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: true, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.projects", valueType: "boolean", limitValue: null, source: "plan", subscriptionId: null } }),
      });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "X" });

      const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(412);
      const json = await res.json() as { error: { details?: { reason?: string } } };
      expect(json.error.details?.reason).toBe("malformed_limit");
    });

    it("does not call billing when policy denies (gate runs after auth)", async () => {
      const env = createFakeEnv({
        POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "denied", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
      });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects`, { name: "Denied" });

      const res = await handleCreateProject(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(404); // policy denial masked as not_found
      const billing = env.BILLING_WORKER as unknown as { fetchCalls: unknown[] };
      expect(billing.fetchCalls.length).toBe(0);
    });
  });
});

describe("handleGetProject", () => {
  it("returns project with authorization", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();

    const res = await handleGetProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });
    expect(res.status).toBe(200);

    const json = await res.json() as { data: { project: { id: string; orgId: string } } };
    expect(json.data.project.id).toMatch(/^prj_/);
    expect(json.data.project.orgId).toMatch(/^org_/);
  });

  it("calls getProjectById with orgId and projectId", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();

    await handleGetProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    expect(projectsRepo.getProjectByIdCalls.length).toBe(1);
    expect(projectsRepo.getProjectByIdCalls[0]).toEqual([TEST_ORG_UUID, TEST_PROJECT_UUID]);
  });

  it("returns 404 when project not found", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getProjectById: async () => ({ ok: false as const, error: { kind: "not_found" as const } }),
    });

    const res = await handleGetProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when membership-context fails", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcherThatThrows() });

    const res = await handleGetProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);
    expect(res.status).toBe(404);
  });

  it("fails closed when policy denies (returns 404 to avoid enumeration)", async () => {
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "denied", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    });
    const projectsRepo = createFakeProjectsRepo();

    const res = await handleGetProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });
    expect(res.status).toBe(404);
    expect(projectsRepo.getProjectByIdCalls.length).toBe(0);
  });

  it("returns 503 when PLATFORM_DB is missing", async () => {
    const env = createFakeEnv({ PLATFORM_DB: undefined });
    const res = await handleGetProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 when MEMBERSHIP_WORKER is missing", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: undefined });
    const res = await handleGetProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 when POLICY_WORKER is missing", async () => {
    const env = createFakeEnv({ POLICY_WORKER: undefined });
    const res = await handleGetProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);
    expect(res.status).toBe(503);
  });

  it("does not expose raw UUIDs in response", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();

    const res = await handleGetProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });
    const text = await res.text();
    expect(text).not.toContain(TEST_ORG_UUID);
    expect(text).not.toContain(TEST_PROJECT_UUID);
  });

  it("sends project.read action with explicit projectId in resource", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();

    await handleGetProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    const policyFetcher = env.POLICY_WORKER as unknown as { fetchCalls: Array<{ url: string; init: RequestInit }> };
    const callBody = JSON.parse(policyFetcher.fetchCalls[0]!.init.body as string);
    expect(callBody.action).toBe("project.read");
    expect(callBody.resource.projectId).toBe(TEST_PROJECT_UUID);
    expect(callBody.resource.orgId).toBe(TEST_ORG_UUID);
    expect(callBody.resource.id).toBe(TEST_PROJECT_UUID);
  });
});

describe("handleListProjects", () => {
  function listRequest(orgPublic: string, query = ""): Request {
    return new Request(`https://projects.internal/v1/organizations/${orgPublic}/projects${query}`, {
      method: "GET",
      headers: {
        "x-actor-subject-id": TEST_USER_ID,
        "x-actor-subject-type": "user",
        "x-request-id": "req_test",
      },
    });
  }

  it("returns paginated project list on success", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(200);
    const json = await response.json() as JsonResp;
    expect(json.data.projects).toHaveLength(1);
    expect(json.data.projects[0]!.id).toBe(TEST_PROJECT_PUBLIC);
    expect(json.data.projects[0]!.orgId).toBe(TEST_ORG_PUBLIC);
    expect(json.meta.cursor).toBeNull();
  });

  it("does not expose raw UUIDs in list response", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    const raw = await response.text();
    expect(raw).not.toContain(TEST_ORG_UUID);
    expect(raw).not.toContain(TEST_PROJECT_UUID);
  });

  it("uses default limit of 50 when not specified", async () => {
    const env = createFakeEnv();
    const listCalls: unknown[][] = [];
    const projectsRepo = createFakeProjectsRepo({
      listProjectsPaged: (...args: unknown[]) => {
        listCalls.push(args);
        return Promise.resolve({ ok: true, value: { items: [], nextCursor: null } });
      },
    });

    const request = listRequest(TEST_ORG_PUBLIC);
    await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(listCalls[0]![1]).toEqual({ limit: 50, cursor: null });
  });

  it("respects limit query parameter", async () => {
    const env = createFakeEnv();
    const listCalls: unknown[][] = [];
    const projectsRepo = createFakeProjectsRepo({
      listProjectsPaged: (...args: unknown[]) => {
        listCalls.push(args);
        return Promise.resolve({ ok: true, value: { items: [], nextCursor: null } });
      },
    });

    const request = listRequest(TEST_ORG_PUBLIC, "?limit=10");
    await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect((listCalls[0]![1] as { limit: number }).limit).toBe(10);
  });

  it("returns validation_failed for limit > 100", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC, "?limit=200");
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(422);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("validation_failed");
  });

  it("returns validation_failed for invalid cursor", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC, "?cursor=not-valid");
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(422);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("validation_failed");
  });

  it("returns next cursor when more pages exist", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      listProjectsPaged: () => Promise.resolve({
        ok: true,
        value: {
          items: [fakeProject],
          nextCursor: { createdAt: "2026-01-01T00:00:00.000Z", id: TEST_PROJECT_UUID },
        },
      }),
    });

    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(200);
    const json = await response.json() as JsonResp;
    expect(json.meta.cursor).not.toBeNull();
    expect(typeof json.meta.cursor).toBe("string");
  });

  it("returns 404 for malformed org ID via router", async () => {
    const env = createFakeEnv();
    const request = new Request("https://projects.internal/v1/organizations/bad-org/projects", {
      method: "GET",
      headers: {
        "x-actor-subject-id": TEST_USER_ID,
        "x-actor-subject-type": "user",
      },
    });

    const response = await route(request, env);
    expect(response.status).toBe(404);
  });

  it("returns 503 when PLATFORM_DB is missing", async () => {
    const env = createFakeEnv({ PLATFORM_DB: undefined });
    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID);

    expect(response.status).toBe(503);
  });

  it("returns 503 when MEMBERSHIP_WORKER is missing", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: undefined });
    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID);

    expect(response.status).toBe(503);
  });

  it("returns 503 when POLICY_WORKER is missing", async () => {
    const env = createFakeEnv({ POLICY_WORKER: undefined });
    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID);

    expect(response.status).toBe(503);
  });

  it("returns 404 when membership-context fails", async () => {
    const env = createFakeEnv({
      MEMBERSHIP_WORKER: createMockFetcher({ error: "not found" }, 404),
    });
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(404);
  });

  it("returns 404 when membership-context returns malformed envelope", async () => {
    const env = createFakeEnv({
      MEMBERSHIP_WORKER: createMockFetcher({ wrong: "shape" }),
    });
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(404);
  });

  it("returns 404 when membership-worker throws network error", async () => {
    const env = createFakeEnv({
      MEMBERSHIP_WORKER: createMockFetcherThatThrows(),
    });
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(404);
  });

  it("returns 404 when policy denies", async () => {
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    });
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(404);
  });

  it("PERF4: deny never leaks data even though read runs in parallel with authz", async () => {
    // The read is started concurrently with the authz fetch; on deny it must be
    // discarded. Assert the denied response carries neither the project nor its
    // raw UUIDs.
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    });
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(404);
    const raw = await response.text();
    expect(raw).not.toContain(TEST_PROJECT_PUBLIC);
    expect(raw).not.toContain(TEST_PROJECT_UUID);
    expect(raw).not.toContain("projects");
  });

  it("PERF4: emits a Server-Timing header with authctx/db/policy/total phases", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(200);
    const timing = response.headers.get("Server-Timing");
    expect(timing).toBeTruthy();
    for (const phase of ["authctx", "db", "policy", "total"]) {
      expect(timing).toContain(phase);
    }
  });

  it("returns 404 when policy returns malformed envelope", async () => {
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({ wrong: "shape" }),
    });
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(404);
  });

  it("returns 404 when policy-worker throws network error", async () => {
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcherThatThrows(),
    });
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(404);
  });

  it("returns 503 when repository fails", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      listProjectsPaged: () => Promise.resolve({ ok: false, error: { kind: "internal", message: "db error" } }),
    });

    const request = listRequest(TEST_ORG_PUBLIC);
    const response = await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    expect(response.status).toBe(503);
  });

  it("sends project.list action with organization-scoped resource", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC);
    await handleListProjects(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, { projectsRepo });

    const policyFetcher = env.POLICY_WORKER as unknown as { fetchCalls: Array<{ url: string; init: RequestInit }> };
    const callBody = JSON.parse(policyFetcher.fetchCalls[0]!.init.body as string);
    expect(callBody.action).toBe("project.list");
    expect(callBody.resource.kind).toBe("organization");
    expect(callBody.resource.orgId).toBe(TEST_ORG_UUID);
    expect(callBody.resource.projectId).toBeUndefined();
  });
});

describe("handleArchiveProject", () => {
  const archivedProject: Project = {
    ...fakeProject,
    status: "archived",
    archivedAt: new Date("2026-01-15T00:00:00Z"),
    updatedAt: new Date("2026-01-15T00:00:00Z"),
  };

  it("archives a project with authorization and atomic event", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveProject: async () => ({ ok: true as const, value: archivedProject }),
    });
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(200);

    const json = await res.json() as { data: { project: { id: string; orgId: string; status: string } } };
    expect(json.data.project.id).toMatch(/^prj_/);
    expect(json.data.project.orgId).toMatch(/^org_/);
    expect(json.data.project.status).toBe("archived");

    expect(eventsRepo.appendEventWithAuditCalls.length).toBe(1);
  });

  it("uses project.delete policy action with explicit project resource shape", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveProject: async () => ({ ok: true as const, value: archivedProject }),
    });
    const eventsRepo = createFakeEventsRepo();

    await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });

    const policyFetcher = env.POLICY_WORKER as unknown as { fetchCalls: Array<{ url: string; init: RequestInit }> };
    const callBody = JSON.parse(policyFetcher.fetchCalls[0]!.init.body as string);
    expect(callBody.action).toBe("project.delete");
    expect(callBody.resource.kind).toBe("project");
    expect(callBody.resource.id).toBe(TEST_PROJECT_UUID);
    expect(callBody.resource.orgId).toBe(TEST_ORG_UUID);
    expect(callBody.resource.projectId).toBe(TEST_PROJECT_UUID);
  });

  it("returns 404 for malformed org/project IDs via router", async () => {
    const env = createFakeEnv();
    const req = makeRequest("DELETE", `/v1/organizations/bad_org/projects/${TEST_PROJECT_PUBLIC}`);
    const res = await route(req, env);
    expect(res.status).toBe(404);

    const req2 = makeRequest("DELETE", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/bad_prj`);
    const res2 = await route(req2, env);
    expect(res2.status).toBe(404);
  });

  it("returns 503 when PLATFORM_DB is missing", async () => {
    const env = createFakeEnv({ PLATFORM_DB: undefined });
    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 when MEMBERSHIP_WORKER is missing", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: undefined });
    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 when POLICY_WORKER is missing", async () => {
    const env = createFakeEnv({ POLICY_WORKER: undefined });
    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);
    expect(res.status).toBe(503);
  });

  it("fails closed when membership-context call fails", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcherThatThrows() });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when membership returns malformed envelope", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcher({ wrong: "shape" }) });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when policy denies", async () => {
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "denied", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when policy-worker fetch throws", async () => {
    const env = createFakeEnv({ POLICY_WORKER: createMockFetcherThatThrows() });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when policy returns malformed envelope", async () => {
    const env = createFakeEnv({ POLICY_WORKER: createMockFetcher({ wrong: "shape" }) });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("returns 404 when project not found in repository", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveProject: async () => ({ ok: false as const, error: { kind: "not_found" as const } }),
    });
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("returns 503 when repository has internal failure", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveProject: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "db error" } }),
    });
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(503);
  });

  it("event append failure prevents successful archive", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveProject: async () => ({ ok: true as const, value: archivedProject }),
    });
    const eventsRepo = createFakeEventsRepo({
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "db error" } }),
    });

    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(503);
  });

  it("does not expose raw UUIDs in response", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveProject: async () => ({ ok: true as const, value: archivedProject }),
    });
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    const text = await res.text();
    expect(text).not.toContain(TEST_ORG_UUID);
    expect(text).not.toContain(TEST_PROJECT_UUID);
  });

  it("does not expose raw UUIDs in event payload", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveProject: async () => ({ ok: true as const, value: archivedProject }),
    });
    const eventsRepo = createFakeEventsRepo();

    await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });

    const eventCall = eventsRepo.appendEventWithAuditCalls[0]![0] as AppendEventWithAuditInput;
    const payload = eventCall.event.payload;
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain(TEST_ORG_UUID);
    expect(payloadStr).not.toContain(TEST_PROJECT_UUID);
    expect(payload.projectId).toMatch(/^prj_/);
    expect(payload.orgId).toMatch(/^org_/);
  });

  it("audit description does not expose raw UUIDs or secrets", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveProject: async () => ({ ok: true as const, value: archivedProject }),
    });
    const eventsRepo = createFakeEventsRepo();

    await handleArchiveProject(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });

    const eventCall = eventsRepo.appendEventWithAuditCalls[0]![0] as AppendEventWithAuditInput;
    const description = eventCall.audit.description;
    expect(description).not.toContain(TEST_ORG_UUID);
    expect(description).not.toContain(TEST_PROJECT_UUID);
    expect(description).toContain("Archived project");
  });
});

const fakeEnvironment: Environment = {
  id: TEST_ENVIRONMENT_UUID,
  orgId: TEST_ORG_UUID,
  projectId: TEST_PROJECT_UUID,
  name: "Production",
  slug: "production",
  slugLower: "production",
  status: "active",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  archivedAt: null,
};

describe("handleCreateEnvironment", () => {
  it("creates an environment with authorization and atomic event", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      createEnvironment: async (input: CreateEnvironmentInput) => ({ ok: true as const, value: { ...fakeEnvironment, id: input.id, name: input.name, slug: input.slug, slugLower: input.slugLower } }),
    });
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Production", slug: "production" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(201);

    const json = await res.json() as { data: { environment: { id: string; orgId: string; projectId: string; name: string; slug: string } } };
    expect(json.data.environment.name).toBe("Production");
    expect(json.data.environment.slug).toBe("production");
    expect(json.data.environment.id).toMatch(/^env_/);
    expect(json.data.environment.orgId).toMatch(/^org_/);
    expect(json.data.environment.projectId).toMatch(/^prj_/);

    expect(eventsRepo.appendEventWithAuditCalls.length).toBe(1);
  });

  it("uses environment.create policy action with explicit project resource shape", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      createEnvironment: async (input: CreateEnvironmentInput) => ({ ok: true as const, value: { ...fakeEnvironment, id: input.id, name: input.name, slug: input.slug, slugLower: input.slugLower } }),
    });
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Staging" });

    await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });

    const policyFetcher = env.POLICY_WORKER as unknown as { fetchCalls: Array<{ url: string; init: RequestInit }> };
    const callBody = JSON.parse(policyFetcher.fetchCalls[0]!.init.body as string);
    expect(callBody.action).toBe("environment.create");
    expect(callBody.resource.kind).toBe("environment");
    expect(callBody.resource.orgId).toBe(TEST_ORG_UUID);
    expect(callBody.resource.projectId).toBe(TEST_PROJECT_UUID);
  });

  it("returns 404 when parent project not found", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getProjectById: async () => ({ ok: false as const, error: { kind: "not_found" as const } }),
      createEnvironment: async (input: CreateEnvironmentInput) => ({ ok: true as const, value: { ...fakeEnvironment, id: input.id } }),
    });
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("returns 404 when parent project is archived", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getProjectById: async () => ({ ok: true as const, value: { ...fakeProject, status: "archived" } }),
      createEnvironment: async (input: CreateEnvironmentInput) => ({ ok: true as const, value: { ...fakeEnvironment, id: input.id } }),
    });
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("returns 409 on duplicate slug conflict", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      createEnvironment: async () => ({ ok: false as const, error: { kind: "conflict" as const, entity: "environment" } }),
    });
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test", slug: "existing" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(409);
  });

  it("event append failure prevents successful create", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      createEnvironment: async (input: CreateEnvironmentInput) => ({ ok: true as const, value: { ...fakeEnvironment, id: input.id } }),
    });
    const eventsRepo = createFakeEventsRepo({
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "db error" } }),
    });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(503);
  });

  it("returns 503 when PLATFORM_DB is missing", async () => {
    const env = createFakeEnv({ PLATFORM_DB: undefined });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 when MEMBERSHIP_WORKER is missing", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: undefined });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 when POLICY_WORKER is missing", async () => {
    const env = createFakeEnv({ POLICY_WORKER: undefined });
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);
    expect(res.status).toBe(503);
  });

  it("fails closed when membership-context call fails", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcherThatThrows() });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when membership returns malformed envelope", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcher({ wrong: "shape" }) });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when policy denies", async () => {
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "denied", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when policy-worker fetch throws", async () => {
    const env = createFakeEnv({ POLICY_WORKER: createMockFetcherThatThrows() });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when policy returns malformed envelope", async () => {
    const env = createFakeEnv({ POLICY_WORKER: createMockFetcher({ wrong: "shape" }) });
    const projectsRepo = createFakeProjectsRepo();
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("does not expose raw UUIDs in response", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      createEnvironment: async (input: CreateEnvironmentInput) => ({ ok: true as const, value: { ...fakeEnvironment, id: input.id } }),
    });
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    const text = await res.text();
    expect(text).not.toContain(TEST_ORG_UUID);
    expect(text).not.toContain(TEST_PROJECT_UUID);
  });

  it("does not expose raw UUIDs in event payload", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      createEnvironment: async (input: CreateEnvironmentInput) => ({ ok: true as const, value: { ...fakeEnvironment, id: input.id } }),
    });
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });

    const eventCall = eventsRepo.appendEventWithAuditCalls[0]![0] as AppendEventWithAuditInput;
    const payload = eventCall.event.payload;
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain(TEST_ORG_UUID);
    expect(payloadStr).not.toContain(TEST_PROJECT_UUID);
    expect(payload.environmentId).toMatch(/^env_/);
    expect(payload.projectId).toMatch(/^prj_/);
    expect(payload.orgId).toMatch(/^org_/);
  });

  it("returns 503 when repository has internal failure", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      createEnvironment: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "db error" } }),
    });
    const eventsRepo = createFakeEventsRepo();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Test" });

    const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(503);
  });

  // ── Billing entitlement gate (Task 0081) ──
  describe("billing entitlement gate (limit.environments)", () => {
    it("returns 503 when BILLING_WORKER binding is missing", async () => {
      const env = createFakeEnv({ BILLING_WORKER: undefined });
      const projectsRepo = createFakeProjectsRepo({
        createEnvironment: async (input: CreateEnvironmentInput) => ({ ok: true as const, value: { ...fakeEnvironment, id: input.id } }),
      });
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "X" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(503);
      expect(projectsRepo.createEnvironmentCalls.length).toBe(0);
      expect(eventsRepo.appendEventWithAuditCalls.length).toBe(0);
    });

    it("sends x-internal-caller=projects-worker and limit.environments on the billing call", async () => {
      const env = createFakeEnv();
      const projectsRepo = createFakeProjectsRepo({
        createEnvironment: async (input: CreateEnvironmentInput) => ({ ok: true as const, value: { ...fakeEnvironment, id: input.id } }),
      });
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Hello" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(201);

      const billing = env.BILLING_WORKER as unknown as { fetchCalls: Array<{ url: string; init: RequestInit }> };
      expect(billing.fetchCalls.length).toBe(1);
      const call = billing.fetchCalls[0]!;
      expect(call.url).toContain("/v1/internal/billing/entitlements/check");
      const headers = call.init.headers as Record<string, string>;
      expect(headers["x-internal-caller"]).toBe("projects-worker");
      expect(headers["x-request-id"]).toBeTruthy();
      const sent = JSON.parse(call.init.body as string) as { orgId: string; entitlementKey: string };
      expect(sent.orgId).toBe(TEST_ORG_PUBLIC);
      expect(sent.entitlementKey).toBe("limit.environments");
    });

    it("allows creation when active environment count is strictly under the quantity limit", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: true, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.environments", valueType: "quantity", limitValue: 5, source: "plan", subscriptionId: null } }),
      });
      const projectsRepo = createFakeProjectsRepo({
        countActiveEnvironments: async () => ({ ok: true as const, value: 4 }),
        createEnvironment: async (input: CreateEnvironmentInput) => ({ ok: true as const, value: { ...fakeEnvironment, id: input.id } }),
      });
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Under Limit" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(201);
    });

    it("scopes the active-count lookup to (orgId, projectId)", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: true, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.environments", valueType: "quantity", limitValue: 5, source: "plan", subscriptionId: null } }),
      });
      const countCalls: unknown[][] = [];
      const projectsRepo = createFakeProjectsRepo({
        countActiveEnvironments: async (...args: unknown[]) => {
          countCalls.push(args);
          return { ok: true as const, value: 0 };
        },
        createEnvironment: async (input: CreateEnvironmentInput) => ({ ok: true as const, value: { ...fakeEnvironment, id: input.id } }),
      });
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Scope" });

      await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(countCalls.length).toBe(1);
      expect(countCalls[0]).toEqual([TEST_ORG_UUID, TEST_PROJECT_UUID]);
    });

    it("denies with 412 limit_reached when active count meets the quantity limit", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: true, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.environments", valueType: "quantity", limitValue: 3, source: "plan", subscriptionId: null } }),
      });
      const projectsRepo = createFakeProjectsRepo({
        countActiveEnvironments: async () => ({ ok: true as const, value: 3 }),
      });
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "At Limit" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(412);
      const json = await res.json() as { error: { code: string; details?: { reason?: string } } };
      expect(json.error.code).toBe("precondition_failed");
      expect(json.error.details?.reason).toBe("limit_reached");
      expect(projectsRepo.createEnvironmentCalls.length).toBe(0);
      expect(eventsRepo.appendEventWithAuditCalls.length).toBe(0);
    });

    it("denies with 412 disabled when billing entitlement is disabled", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: false, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.environments", reason: "disabled" } }),
      });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Blocked" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(412);
      const json = await res.json() as { error: { code: string; details?: { reason?: string } } };
      expect(json.error.code).toBe("precondition_failed");
      expect(json.error.details?.reason).toBe("disabled");
      expect(projectsRepo.createEnvironmentCalls.length).toBe(0);
    });

    it("denies with 412 not_configured when no entitlement exists for the org", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: false, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.environments", reason: "not_configured" } }),
      });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Blocked" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(412);
      const json = await res.json() as { error: { code: string; details?: { reason?: string } } };
      expect(json.error.code).toBe("precondition_failed");
      expect(json.error.details?.reason).toBe("not_configured");
    });

    it("returns 503 when billing-worker returns non-OK (fail-closed)", async () => {
      const env = createFakeEnv({ BILLING_WORKER: createMockFetcher({}, 500) });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "X" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(503);
      expect(projectsRepo.createEnvironmentCalls.length).toBe(0);
    });

    it("returns 503 when billing-worker fetch throws (fail-closed)", async () => {
      const env = createFakeEnv({ BILLING_WORKER: createMockFetcherThatThrows() });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "X" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(503);
      expect(projectsRepo.createEnvironmentCalls.length).toBe(0);
    });

    it("returns 503 when billing-worker returns malformed envelope (fail-closed)", async () => {
      const env = createFakeEnv({ BILLING_WORKER: createMockFetcher({ wrong: "shape" }) });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "X" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(503);
    });

    it("returns 503 when active-environment count lookup fails (fail-closed)", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: true, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.environments", valueType: "quantity", limitValue: 5, source: "plan", subscriptionId: null } }),
      });
      const projectsRepo = createFakeProjectsRepo({
        countActiveEnvironments: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "boom" } }),
      });
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "X" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(503);
      expect(projectsRepo.createEnvironmentCalls.length).toBe(0);
    });

    it("denies with 412 malformed_limit when billing returns a non-quantity valueType for limit.environments", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: true, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.environments", valueType: "boolean", limitValue: null, source: "plan", subscriptionId: null } }),
      });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "X" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(412);
      const json = await res.json() as { error: { details?: { reason?: string } } };
      expect(json.error.details?.reason).toBe("malformed_limit");
    });

    it("allows creation when limitValue is null (unlimited)", async () => {
      const env = createFakeEnv({
        BILLING_WORKER: createMockFetcher({ data: { allowed: true, orgId: TEST_ORG_PUBLIC, entitlementKey: "limit.environments", valueType: "quantity", limitValue: null, source: "plan", subscriptionId: null } }),
      });
      const projectsRepo = createFakeProjectsRepo({
        countActiveEnvironments: async () => ({ ok: true as const, value: 9999 }),
        createEnvironment: async (input: CreateEnvironmentInput) => ({ ok: true as const, value: { ...fakeEnvironment, id: input.id } }),
      });
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Unlimited" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(201);
    });

    it("does not call billing when policy denies (gate runs after auth)", async () => {
      const env = createFakeEnv({
        POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "denied", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
      });
      const projectsRepo = createFakeProjectsRepo();
      const eventsRepo = createFakeEventsRepo();
      const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "Denied" });

      const res = await handleCreateEnvironment(req, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo, eventsRepo });
      expect(res.status).toBe(404);
      const billing = env.BILLING_WORKER as unknown as { fetchCalls: unknown[] };
      expect(billing.fetchCalls.length).toBe(0);
    });
  });
});

describe("handleListEnvironments", () => {
  function listRequest(orgPublic: string, projectPublic: string, query = ""): Request {
    return new Request(`https://projects.internal/v1/organizations/${orgPublic}/projects/${projectPublic}/environments${query}`, {
      method: "GET",
      headers: {
        "x-actor-subject-id": TEST_USER_ID,
        "x-actor-subject-type": "user",
        "x-request-id": "req_test",
      },
    });
  }

  it("returns paginated environment list on success", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      listEnvironmentsPaged: () => Promise.resolve({ ok: true as const, value: { items: [fakeEnvironment], nextCursor: null } }),
    });

    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC);
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    expect(response.status).toBe(200);
    const json = await response.json() as JsonResp;
    expect(json.data.environments).toHaveLength(1);
    expect(json.data.environments[0]!.id).toBe(TEST_ENVIRONMENT_PUBLIC);
    expect(json.data.environments[0]!.orgId).toBe(TEST_ORG_PUBLIC);
    expect(json.data.environments[0]!.projectId).toBe(TEST_PROJECT_PUBLIC);
    expect(json.meta.cursor).toBeNull();
  });

  it("returns 404 when parent project not found", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getProjectById: async () => ({ ok: false as const, error: { kind: "not_found" as const } }),
    });

    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC);
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    expect(response.status).toBe(404);
  });

  it("returns 404 when parent project is archived", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getProjectById: async () => ({ ok: true as const, value: { ...fakeProject, status: "archived" } }),
    });

    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC);
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    expect(response.status).toBe(404);
  });

  it("uses default limit of 50", async () => {
    const env = createFakeEnv();
    const listCalls: unknown[][] = [];
    const projectsRepo = createFakeProjectsRepo({
      listEnvironmentsPaged: (...args: unknown[]) => {
        listCalls.push(args);
        return Promise.resolve({ ok: true, value: { items: [], nextCursor: null } });
      },
    });

    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC);
    await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    expect(listCalls[0]![2]).toEqual({ limit: 50, cursor: null });
  });

  it("respects limit query parameter", async () => {
    const env = createFakeEnv();
    const listCalls: unknown[][] = [];
    const projectsRepo = createFakeProjectsRepo({
      listEnvironmentsPaged: (...args: unknown[]) => {
        listCalls.push(args);
        return Promise.resolve({ ok: true, value: { items: [], nextCursor: null } });
      },
    });

    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC, "?limit=10");
    await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    expect((listCalls[0]![2] as { limit: number }).limit).toBe(10);
  });

  it("returns validation_failed for limit > 100", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC, "?limit=200");
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    expect(response.status).toBe(422);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("validation_failed");
  });

  it("returns validation_failed for invalid cursor", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC, "?cursor=not-valid");
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    expect(response.status).toBe(422);
    const json = await response.json() as JsonResp;
    expect(json.error.code).toBe("validation_failed");
  });

  it("returns next cursor when more pages exist", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      listEnvironmentsPaged: () => Promise.resolve({
        ok: true as const,
        value: {
          items: [fakeEnvironment],
          nextCursor: { createdAt: "2026-01-01T00:00:00.000Z", id: TEST_ENVIRONMENT_UUID },
        },
      }),
    });

    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC);
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    expect(response.status).toBe(200);
    const json = await response.json() as JsonResp;
    expect(json.meta.cursor).not.toBeNull();
    expect(typeof json.meta.cursor).toBe("string");
  });

  it("does not expose raw UUIDs in list response", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      listEnvironmentsPaged: () => Promise.resolve({ ok: true as const, value: { items: [fakeEnvironment], nextCursor: null } }),
    });

    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC);
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    const raw = await response.text();
    expect(raw).not.toContain(TEST_ORG_UUID);
    expect(raw).not.toContain(TEST_PROJECT_UUID);
    expect(raw).not.toContain(TEST_ENVIRONMENT_UUID);
  });

  it("returns 503 when PLATFORM_DB is missing", async () => {
    const env = createFakeEnv({ PLATFORM_DB: undefined });
    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC);
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);

    expect(response.status).toBe(503);
  });

  it("returns 503 when MEMBERSHIP_WORKER is missing", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: undefined });
    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC);
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);

    expect(response.status).toBe(503);
  });

  it("returns 503 when POLICY_WORKER is missing", async () => {
    const env = createFakeEnv({ POLICY_WORKER: undefined });
    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC);
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID);

    expect(response.status).toBe(503);
  });

  it("fails closed when membership-context fails", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcherThatThrows() });
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC);
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    expect(response.status).toBe(404);
  });

  it("fails closed when policy denies", async () => {
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    });
    const projectsRepo = createFakeProjectsRepo();

    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC);
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    expect(response.status).toBe(404);
  });

  it("returns 503 when repository fails", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      listEnvironmentsPaged: () => Promise.resolve({ ok: false as const, error: { kind: "internal" as const, message: "db error" } }),
    });

    const request = listRequest(TEST_ORG_PUBLIC, TEST_PROJECT_PUBLIC);
    const response = await handleListEnvironments(request, env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, { projectsRepo });

    expect(response.status).toBe(503);
  });
});

describe("handleGetEnvironment", () => {
  it("returns environment with authorization", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getEnvironmentById: async () => ({ ok: true as const, value: fakeEnvironment }),
    });

    const res = await handleGetEnvironment(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo });
    expect(res.status).toBe(200);

    const json = await res.json() as { data: { environment: { id: string; orgId: string; projectId: string } } };
    expect(json.data.environment.id).toMatch(/^env_/);
    expect(json.data.environment.orgId).toMatch(/^org_/);
    expect(json.data.environment.projectId).toMatch(/^prj_/);
  });

  it("returns 404 when parent project not found", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getProjectById: async () => ({ ok: false as const, error: { kind: "not_found" as const } }),
      getEnvironmentById: async () => ({ ok: true as const, value: fakeEnvironment }),
    });

    const res = await handleGetEnvironment(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo });
    expect(res.status).toBe(404);
  });

  it("returns 404 when parent project is archived", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getProjectById: async () => ({ ok: true as const, value: { ...fakeProject, status: "archived" } }),
      getEnvironmentById: async () => ({ ok: true as const, value: fakeEnvironment }),
    });

    const res = await handleGetEnvironment(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo });
    expect(res.status).toBe(404);
  });

  it("returns 404 when environment not found", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getEnvironmentById: async () => ({ ok: false as const, error: { kind: "not_found" as const } }),
    });

    const res = await handleGetEnvironment(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo });
    expect(res.status).toBe(404);
  });

  it("fails closed when membership-context fails", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: createMockFetcherThatThrows() });

    const res = await handleGetEnvironment(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID);
    expect(res.status).toBe(404);
  });

  it("fails closed when policy denies", async () => {
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "denied", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    });
    const projectsRepo = createFakeProjectsRepo({
      getEnvironmentById: async () => ({ ok: true as const, value: fakeEnvironment }),
    });

    const res = await handleGetEnvironment(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo });
    expect(res.status).toBe(404);
  });

  it("returns 503 when PLATFORM_DB is missing", async () => {
    const env = createFakeEnv({ PLATFORM_DB: undefined });
    const res = await handleGetEnvironment(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 when MEMBERSHIP_WORKER is missing", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: undefined });
    const res = await handleGetEnvironment(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 when POLICY_WORKER is missing", async () => {
    const env = createFakeEnv({ POLICY_WORKER: undefined });
    const res = await handleGetEnvironment(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID);
    expect(res.status).toBe(503);
  });

  it("does not expose raw UUIDs in response", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getEnvironmentById: async () => ({ ok: true as const, value: fakeEnvironment }),
    });

    const res = await handleGetEnvironment(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo });
    const text = await res.text();
    expect(text).not.toContain(TEST_ORG_UUID);
    expect(text).not.toContain(TEST_PROJECT_UUID);
    expect(text).not.toContain(TEST_ENVIRONMENT_UUID);
  });

  it("sends environment.read action with explicit environment resource shape", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getEnvironmentById: async () => ({ ok: true as const, value: fakeEnvironment }),
    });

    await handleGetEnvironment(env, "req_test", { subjectId: TEST_USER_ID, subjectType: "user" }, TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo });

    const policyFetcher = env.POLICY_WORKER as unknown as { fetchCalls: Array<{ url: string; init: RequestInit }> };
    const callBody = JSON.parse(policyFetcher.fetchCalls[0]!.init.body as string);
    expect(callBody.action).toBe("environment.read");
    expect(callBody.resource.kind).toBe("environment");
    expect(callBody.resource.id).toBe(TEST_ENVIRONMENT_UUID);
    expect(callBody.resource.orgId).toBe(TEST_ORG_UUID);
    expect(callBody.resource.projectId).toBe(TEST_PROJECT_UUID);
    expect(callBody.resource.environmentId).toBe(TEST_ENVIRONMENT_UUID);
  });
});

describe("environment router routes", () => {
  it("returns 404 for malformed org ID on environment collection", async () => {
    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/bad_org/projects/${TEST_PROJECT_PUBLIC}/environments`, { name: "test" });
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 404 for malformed project ID on environment collection", async () => {
    const env = createFakeEnv();
    const req = makeRequest("POST", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/bad_prj/environments`, { name: "test" });
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 404 for malformed environment ID on environment item", async () => {
    const env = createFakeEnv();
    const req = makeRequest("GET", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments/bad_env`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 401 for missing actor on POST environments", async () => {
    const env = createFakeEnv();
    const req = new Request(`https://projects-worker/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 for missing actor on GET environments", async () => {
    const env = createFakeEnv();
    const req = new Request(`https://projects-worker/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`, {
      method: "GET",
    });
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 for missing actor on GET environment item", async () => {
    const env = createFakeEnv();
    const req = new Request(`https://projects-worker/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments/${TEST_ENVIRONMENT_PUBLIC}`, {
      method: "GET",
    });
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 405 for unsupported methods on environments collection", async () => {
    const env = createFakeEnv();
    const req = makeRequest("DELETE", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 405 for unsupported methods on environment item", async () => {
    const env = createFakeEnv();
    const req = makeRequest("PATCH", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments/${TEST_ENVIRONMENT_PUBLIC}`);
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });

  it("returns 401 for missing actor on DELETE environment item", async () => {
    const env = createFakeEnv();
    const req = new Request(`https://projects-worker/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments/${TEST_ENVIRONMENT_PUBLIC}`, {
      method: "DELETE",
    });
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("routes DELETE on environment item to handleArchiveEnvironment", async () => {
    const env = createFakeEnv();
    const req = makeRequest("DELETE", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments/${TEST_ENVIRONMENT_PUBLIC}`);
    const res = await route(req, env);
    expect([200, 404, 503]).toContain(res.status);
  });
});

describe("handleArchiveEnvironment", () => {
  const archivedEnvironment: Environment = {
    ...fakeEnvironment,
    status: "archived",
    archivedAt: new Date("2026-01-15T00:00:00Z"),
    updatedAt: new Date("2026-01-15T00:00:00Z"),
  };

  it("archives an environment with authorization and atomic event", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveEnvironment: async () => ({ ok: true as const, value: archivedEnvironment }),
    });
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(200);
    const json = await res.json() as { data: { environment: { id: string; orgId: string; projectId: string; status: string; archivedAt: string } } };
    expect(json.data.environment.status).toBe("archived");
    expect(json.data.environment.archivedAt).toBeTruthy();
    expect(json.data.environment.id).toMatch(/^env_/);
    expect(json.data.environment.orgId).toMatch(/^org_/);
    expect(json.data.environment.projectId).toMatch(/^prj_/);
    expect(eventsRepo.appendEventWithAuditCalls.length).toBe(1);
  });

  it("uses environment.delete policy action with explicit environment resource shape", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveEnvironment: async () => ({ ok: true as const, value: archivedEnvironment }),
    });
    const eventsRepo = createFakeEventsRepo();

    await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo, eventsRepo });

    const policyFetcher = env.POLICY_WORKER as unknown as { fetchCalls: Array<{ url: string; init: RequestInit }> };
    expect(policyFetcher.fetchCalls.length).toBeGreaterThan(0);
    const callBody = JSON.parse(policyFetcher.fetchCalls[0]!.init.body as string);
    expect(callBody.action).toBe("environment.delete");
    expect(callBody.resource.kind).toBe("environment");
    expect(callBody.resource.id).toBe(TEST_ENVIRONMENT_UUID);
    expect(callBody.resource.orgId).toBe(TEST_ORG_UUID);
    expect(callBody.resource.projectId).toBe(TEST_PROJECT_UUID);
    expect(callBody.resource.environmentId).toBe(TEST_ENVIRONMENT_UUID);
  });

  it("returns 404 for malformed org public ID", async () => {
    const env = createFakeEnv();
    const req = makeRequest("DELETE", `/v1/organizations/invalid_id/projects/${TEST_PROJECT_PUBLIC}/environments/${TEST_ENVIRONMENT_PUBLIC}`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 404 for malformed project public ID", async () => {
    const env = createFakeEnv();
    const req = makeRequest("DELETE", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/invalid_id/environments/${TEST_ENVIRONMENT_PUBLIC}`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 404 for malformed environment public ID", async () => {
    const env = createFakeEnv();
    const req = makeRequest("DELETE", `/v1/organizations/${TEST_ORG_PUBLIC}/projects/${TEST_PROJECT_PUBLIC}/environments/invalid_id`);
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 404 when parent project is missing", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getProjectById: async () => ({ ok: false as const, error: { kind: "not_found" as const } }),
      archiveEnvironment: async () => ({ ok: true as const, value: archivedEnvironment }),
    });
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("returns 404 when parent project is archived", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      getProjectById: async () => ({ ok: true as const, value: { ...fakeProject, status: "archived" } }),
      archiveEnvironment: async () => ({ ok: true as const, value: archivedEnvironment }),
    });
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("returns 404 when environment is missing or already archived", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveEnvironment: async () => ({ ok: false as const, error: { kind: "not_found" as const } }),
    });
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("returns 404 when policy denies access", async () => {
    const env = createFakeEnv({
      POLICY_WORKER: createMockFetcher({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    });
    const projectsRepo = createFakeProjectsRepo({
      archiveEnvironment: async () => ({ ok: true as const, value: archivedEnvironment }),
    });
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("returns 404 when membership-context fetch fails", async () => {
    const env = createFakeEnv({
      MEMBERSHIP_WORKER: createMockFetcher({ error: "failed" }, 500),
    });
    const projectsRepo = createFakeProjectsRepo({
      archiveEnvironment: async () => ({ ok: true as const, value: archivedEnvironment }),
    });
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(404);
  });

  it("returns 503 when event append fails (rollback behavior)", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveEnvironment: async () => ({ ok: true as const, value: archivedEnvironment }),
    });
    const eventsRepo = createFakeEventsRepo({
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "db error" } }),
    });

    const res = await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(503);
  });

  it("returns 503 when PLATFORM_DB is missing", async () => {
    const env = createFakeEnv({ PLATFORM_DB: undefined });
    const res = await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 when MEMBERSHIP_WORKER is missing", async () => {
    const env = createFakeEnv({ MEMBERSHIP_WORKER: undefined });
    const res = await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 when POLICY_WORKER is missing", async () => {
    const env = createFakeEnv({ POLICY_WORKER: undefined });
    const res = await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID);
    expect(res.status).toBe(503);
  });

  it("returns 503 on repository internal failure", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveEnvironment: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "unexpected" } }),
    });
    const eventsRepo = createFakeEventsRepo();

    const res = await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo, eventsRepo });
    expect(res.status).toBe(503);
  });

  it("event payload uses public IDs and does not expose raw UUIDs", async () => {
    const env = createFakeEnv();
    const projectsRepo = createFakeProjectsRepo({
      archiveEnvironment: async () => ({ ok: true as const, value: archivedEnvironment }),
    });
    const eventsRepo = createFakeEventsRepo();

    await handleArchiveEnvironment(env, "req_test",
      { subjectId: TEST_USER_ID, subjectType: "user" },
      TEST_ORG_UUID, TEST_PROJECT_UUID, TEST_ENVIRONMENT_UUID, { projectsRepo, eventsRepo });

    expect(eventsRepo.appendEventWithAuditCalls.length).toBe(1);
    const eventInput = eventsRepo.appendEventWithAuditCalls[0]![0] as AppendEventWithAuditInput;
    expect(eventInput.event.type).toBe("environment.archived");
    expect(eventInput.event.source).toBe("projects-worker");
    expect(eventInput.event.subjectKind).toBe("environment");
    expect(eventInput.event.environmentId).toBe(TEST_ENVIRONMENT_UUID);
    expect(eventInput.audit.category).toBe("projects");
    expect(eventInput.audit.environmentId).toBe(TEST_ENVIRONMENT_UUID);

    const payload = eventInput.event.payload as Record<string, unknown>;
    expect(payload.environmentId).toMatch(/^env_/);
    expect(payload.projectId).toMatch(/^prj_/);
    expect(payload.orgId).toMatch(/^org_/);
    const payloadStr = JSON.stringify(payload);
    expect(payloadStr).not.toContain(TEST_ORG_UUID);
    expect(payloadStr).not.toContain(TEST_PROJECT_UUID);
    expect(payloadStr).not.toContain(TEST_ENVIRONMENT_UUID);
  });
});
