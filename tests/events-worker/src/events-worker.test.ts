import { route } from "@events-worker/router";
import type { Env } from "@events-worker/env";
import type { EventsRepository } from "@saas/db/events";

const TEST_ORG_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TEST_ORG_PUBLIC_ID = "org_a1b2c3d4e5f67890abcdef1234567890";
const TEST_ACTOR_ID = "usr_abc123";
const TEST_REQUEST_ID = "req_test123456789012";

function createMockFetcher(handler?: (req: Request) => Promise<Response>): Fetcher {
  return {
    fetch: handler ?? (async () => new Response(null, { status: 500 })),
    connect: undefined as never,
  } as unknown as Fetcher;
}

function createMockDatabase(): D1Database {
  // A binding-shaped stand-in: the routes under test take an injected
  // repository, so nothing here is ever executed — it exists to satisfy Env.
  return {
    prepare: () => {
      throw new Error("unexpected D1 query in a repository-injected test");
    },
  } as unknown as D1Database;
}

function createEnv(overrides?: Record<string, unknown>): Env {
  const base: Env = {
    PLATFORM_DB: createMockDatabase(),
    MEMBERSHIP_WORKER: createMockFetcher(async () =>
      Response.json({ data: { memberships: [{ kind: "role_assignment", role: "owner", scope: { kind: "organization", orgId: TEST_ORG_UUID } }] } }),
    ),
    POLICY_WORKER: createMockFetcher(async () =>
      Response.json({ data: { allow: true, reason: "org_owner", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
    ),
    ENVIRONMENT: "test",
  };
  if (!overrides) return base;
  const result = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }
  return result as unknown as Env;
}

function makeRequest(path: string, options?: RequestInit & { headers?: Record<string, string> }): Request {
  const headers = new Headers(options?.headers ?? {});
  if (!headers.has("x-actor-subject-id")) headers.set("x-actor-subject-id", TEST_ACTOR_ID);
  if (!headers.has("x-actor-subject-type")) headers.set("x-actor-subject-type", "user");
  if (!headers.has("x-request-id")) headers.set("x-request-id", TEST_REQUEST_ID);
  return new Request(`https://events.internal${path}`, {
    method: options?.method ?? "GET",
    headers,
  });
}

describe("events-worker router", () => {
  describe("GET /health", () => {
    it("returns 200 ok", async () => {
      const env = createEnv();
      const res = await route(makeRequest("/health"), env);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.service).toBe("events-worker");
    });
  });

  describe("GET /v1/organizations/{orgId}/audit", () => {
    it("returns 404 for malformed org ID", async () => {
      const env = createEnv();
      const res = await route(makeRequest("/v1/organizations/bad-id/audit"), env);
      expect(res.status).toBe(404);
    });

    it("returns 401 when missing actor headers", async () => {
      const env = createEnv();
      const req = new Request(`https://events.internal/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`, {
        method: "GET",
        headers: { "x-request-id": TEST_REQUEST_ID },
      });
      const res = await route(req, env);
      expect(res.status).toBe(401);
    });

    it("returns 503 when PLATFORM_DB is missing", async () => {
      const env = createEnv({ PLATFORM_DB: undefined });
      const res = await route(makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`), env);
      expect(res.status).toBe(503);
    });

    it("returns 503 when MEMBERSHIP_WORKER is missing", async () => {
      const env = createEnv({ MEMBERSHIP_WORKER: undefined });
      const res = await route(makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`), env);
      expect(res.status).toBe(503);
    });

    it("returns 503 when POLICY_WORKER is missing", async () => {
      const env = createEnv({ POLICY_WORKER: undefined });
      const res = await route(makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`), env);
      expect(res.status).toBe(503);
    });

    it("returns 404 when membership context fails", async () => {
      const env = createEnv({
        MEMBERSHIP_WORKER: createMockFetcher(async () => new Response(null, { status: 500 })),
      });
      const res = await route(makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`), env);
      expect(res.status).toBe(404);
    });

    it("returns 404 when policy denies", async () => {
      const env = createEnv({
        POLICY_WORKER: createMockFetcher(async () =>
          Response.json({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
        ),
      });
      const res = await route(makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`), env);
      expect(res.status).toBe(404);
    });

    it("returns 422 for invalid limit", async () => {
      const env = createEnv();
      const res = await route(makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit?limit=999`), env);
      expect(res.status).toBe(422);
      const body = await res.json() as Record<string, unknown>;
      expect((body as { error: { code: string } }).error.code).toBe("validation_failed");
    });

    it("returns 422 for invalid cursor", async () => {
      const env = createEnv();
      const res = await route(makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit?cursor=invalid!!`), env);
      expect(res.status).toBe(422);
    });

    it("returns 422 for invalid category", async () => {
      const env = createEnv();
      const res = await route(makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit?category=INVALID SPACES`), env);
      expect(res.status).toBe(422);
    });

    it("returns 405 for non-GET methods", async () => {
      const env = createEnv();
      const res = await route(makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`, { method: "POST" }), env);
      expect(res.status).toBe(405);
    });

    it("returns 404 for unknown routes", async () => {
      const env = createEnv();
      const res = await route(makeRequest("/v1/unknown"), env);
      expect(res.status).toBe(404);
    });
  });
});

describe("events-worker list-audit handler", () => {
  it("maps public IDs and redacts payload", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    const mockEntry = {
      id: "aud-001",
      eventId: "evt-001",
      orgId: TEST_ORG_UUID,
      projectId: "b1c2d3e4-f5a6-7890-bcde-f12345678901",
      environmentId: null,
      actorType: "user",
      actorId: TEST_ACTOR_ID,
      eventType: "invite.created",
      eventVersion: 1,
      source: "membership-worker",
      subjectKind: "invitation",
      subjectId: "c1d2e3f4-a5b6-7890-cdef-123456789012",
      subjectName: "test@example.com",
      category: "membership",
      description: "Invitation created",
      occurredAt: new Date("2026-05-26T10:00:00.000Z"),
      requestId: TEST_REQUEST_ID,
      correlationId: null,
      payload: { orgId: TEST_ORG_UUID, token: "secret-token-value" },
      redactPaths: ["payload.token"],
      createdAt: new Date("2026-05-26T10:00:00.000Z"),
    };

    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async () => ({
        ok: true as const,
        value: { items: [mockEntry], nextCursor: null },
      }),
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv();
    const req = makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`);

    const res = await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, TEST_ORG_UUID, { eventsRepo: mockRepo });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { auditEntries: Array<Record<string, unknown>> }; meta: Record<string, unknown> };

    expect(body.data.auditEntries).toHaveLength(1);
    const entry = body.data.auditEntries[0]!;

    expect(entry.orgId).toBe(TEST_ORG_PUBLIC_ID);
    expect(entry.projectId).toBe("prj_b1c2d3e4f5a67890bcdef12345678901");
    expect((entry.subject as { id: string }).id).toBe("inv_c1d2e3f4a5b67890cdef123456789012");
    expect((entry.payload as { token: string }).token).toBe("[REDACTED]");
    expect(body.meta.cursor).toBeNull();
    expect(body.meta.requestId).toBe(TEST_REQUEST_ID);
  });

  it("passes category to repository when provided", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    let capturedCategory: string | undefined;
    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async (_orgId: string, _params: unknown, category?: string) => {
        capturedCategory = category;
        return { ok: true as const, value: { items: [], nextCursor: null } };
      },
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv();
    const req = makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit?category=membership`);

    await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, TEST_ORG_UUID, { eventsRepo: mockRepo });

    expect(capturedCategory).toBe("membership");
  });

  it("returns 503 when repository fails", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async () => ({
        ok: false as const,
        error: { kind: "internal" as const, message: "db error" },
      }),
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv();
    const req = makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`);

    const res = await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, TEST_ORG_UUID, { eventsRepo: mockRepo });
    expect(res.status).toBe(503);
  });

  it("encodes pagination cursor when more results exist", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async () => ({
        ok: true as const,
        value: {
          items: [],
          nextCursor: { occurredAt: "2026-05-26T09:00:00.000Z", id: "aud-050" },
        },
      }),
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv();
    const req = makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`);

    const res = await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, TEST_ORG_UUID, { eventsRepo: mockRepo });

    expect(res.status).toBe(200);
    const body = await res.json() as { meta: { cursor: string | null } };
    expect(body.meta.cursor).not.toBeNull();
    expect(typeof body.meta.cursor).toBe("string");
  });

  it("maps organization subject kind to org_ public ID", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    const orgSubjectUuid = "d1e2f3a4-b5c6-7890-abcd-ef1234567890";
    const mockEntry = {
      id: "aud-org-01",
      eventId: "evt-org-01",
      orgId: TEST_ORG_UUID,
      projectId: null,
      environmentId: null,
      actorType: "user",
      actorId: TEST_ACTOR_ID,
      eventType: "organization.created",
      eventVersion: 1,
      source: "membership-worker",
      subjectKind: "organization",
      subjectId: orgSubjectUuid,
      subjectName: "Acme Corp",
      category: "membership",
      description: "Organization org_d1e2f3a4b5c67890abcdef1234567890 created",
      occurredAt: new Date("2026-05-26T12:00:00.000Z"),
      requestId: TEST_REQUEST_ID,
      correlationId: null,
      payload: { orgId: "org_d1e2f3a4b5c67890abcdef1234567890", name: "Acme Corp", slug: "acme-corp" },
      redactPaths: [],
      createdAt: new Date("2026-05-26T12:00:00.000Z"),
    };

    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async () => ({
        ok: true as const,
        value: { items: [mockEntry], nextCursor: null },
      }),
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv();
    const req = makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`);

    const res = await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, TEST_ORG_UUID, { eventsRepo: mockRepo });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { auditEntries: Array<Record<string, unknown>> } };
    const entry = body.data.auditEntries[0]!;

    // orgId should be mapped to public org_ format
    expect(entry.orgId).toBe(TEST_ORG_PUBLIC_ID);
    // Subject should be mapped with org_ prefix
    const subject = entry.subject as { kind: string; id: string; name: string | null };
    expect(subject.kind).toBe("organization");
    expect(subject.id).toBe("org_d1e2f3a4b5c67890abcdef1234567890");
    expect(subject.name).toBe("Acme Corp");
    // No raw UUID in the public response
    expect(JSON.stringify(entry)).not.toContain(orgSubjectUuid);
    expect(JSON.stringify(entry)).not.toContain(TEST_ORG_UUID);
  });

  it("maps member subject kind to mem_ public ID", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    const memberSubjectUuid = "e2f3a4b5-c6d7-8901-bcde-f12345678901";
    const mockEntry = {
      id: "aud-mem-01",
      eventId: "evt-mem-01",
      orgId: TEST_ORG_UUID,
      projectId: null,
      environmentId: null,
      actorType: "user",
      actorId: TEST_ACTOR_ID,
      eventType: "membership.added",
      eventVersion: 1,
      source: "membership-worker",
      subjectKind: "member",
      subjectId: memberSubjectUuid,
      subjectName: null,
      category: "membership",
      description: "Member mem_e2f3a4b5c6d78901bcdef12345678901 added as owner",
      occurredAt: new Date("2026-05-26T12:00:01.000Z"),
      requestId: TEST_REQUEST_ID,
      correlationId: null,
      payload: { orgId: "org_a1b2c3d4e5f67890abcdef1234567890", memberId: "mem_e2f3a4b5c6d78901bcdef12345678901", subjectType: "user", subjectId: "usr_abc123", role: "owner" },
      redactPaths: [],
      createdAt: new Date("2026-05-26T12:00:01.000Z"),
    };

    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async () => ({
        ok: true as const,
        value: { items: [mockEntry], nextCursor: null },
      }),
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv();
    const req = makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`);

    const res = await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, TEST_ORG_UUID, { eventsRepo: mockRepo });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { auditEntries: Array<Record<string, unknown>> } };
    const entry = body.data.auditEntries[0]!;

    // orgId should be mapped to public org_ format
    expect(entry.orgId).toBe(TEST_ORG_PUBLIC_ID);
    // Subject should be mapped with mem_ prefix
    const subject = entry.subject as { kind: string; id: string; name: string | null };
    expect(subject.kind).toBe("member");
    expect(subject.id).toBe("mem_e2f3a4b5c6d78901bcdef12345678901");
    // No raw UUID in the public response for known scope/subject fields
    expect(entry.orgId).not.toContain("-");
    expect(subject.id).not.toContain("-");
  });

  it("does not leak raw UUIDs in organization.created public audit response", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    const orgUuid = "f1a2b3c4-d5e6-7890-abcd-ef1234567890";
    const mockEntry = {
      id: "aud-leak-01",
      eventId: "evt-leak-01",
      orgId: orgUuid,
      projectId: null,
      environmentId: null,
      actorType: "user",
      actorId: TEST_ACTOR_ID,
      eventType: "organization.created",
      eventVersion: 1,
      source: "membership-worker",
      subjectKind: "organization",
      subjectId: orgUuid,
      subjectName: "Leak Test Org",
      category: "membership",
      description: "Organization org_f1a2b3c4d5e67890abcdef1234567890 created",
      occurredAt: new Date("2026-05-26T14:00:00.000Z"),
      requestId: TEST_REQUEST_ID,
      correlationId: null,
      payload: { orgId: "org_f1a2b3c4d5e67890abcdef1234567890", name: "Leak Test Org", slug: "leak-test" },
      redactPaths: [],
      createdAt: new Date("2026-05-26T14:00:00.000Z"),
    };

    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async () => ({
        ok: true as const,
        value: { items: [mockEntry], nextCursor: null },
      }),
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv();
    const req = makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`);

    const res = await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, orgUuid, { eventsRepo: mockRepo });

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { auditEntries: Array<Record<string, unknown>> } };
    const responseStr = JSON.stringify(body.data.auditEntries[0]);

    // Raw UUID format must not appear in orgId or subject.id
    expect(responseStr).not.toMatch(/f1a2b3c4-d5e6-7890-abcd-ef1234567890/);
    // Public org_ and prefixed IDs should be present
    expect(responseStr).toContain("org_f1a2b3c4d5e67890abcdef1234567890");
  });

  it("threads validated filters into the repository call", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    let capturedFilters: Record<string, unknown> | undefined;
    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async (_orgId: string, _params: unknown, _category?: string, filters?: Record<string, unknown>) => {
        capturedFilters = filters;
        return { ok: true as const, value: { items: [], nextCursor: null } };
      },
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv();
    const req = makeRequest(
      `/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit?actorId=usr_abc&actorType=user&subjectKind=project&subjectId=prj_9&eventType=member.role_changed&from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z`,
    );

    const res = await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, TEST_ORG_UUID, { eventsRepo: mockRepo });

    expect(res.status).toBe(200);
    expect(capturedFilters).toEqual({
      actorId: "usr_abc",
      actorType: "user",
      subjectKind: "project",
      subjectId: "prj_9",
      eventType: "member.role_changed",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
    });
  });

  it("rejects a malformed from timestamp with 422", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv();
    const req = makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit?from=2026-01-01`);

    const res = await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, TEST_ORG_UUID, { eventsRepo: mockRepo });
    expect(res.status).toBe(422);
  });

  it("rejects an unknown actorType with 422", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv();
    const req = makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit?actorType=robot`);

    const res = await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, TEST_ORG_UUID, { eventsRepo: mockRepo });
    expect(res.status).toBe(422);
  });

  it("ignores empty filter params (no filters passed to repo)", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    let capturedFilters: Record<string, unknown> | undefined;
    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async (_orgId: string, _params: unknown, _category?: string, filters?: Record<string, unknown>) => {
        capturedFilters = filters;
        return { ok: true as const, value: { items: [], nextCursor: null } };
      },
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv();
    const req = makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit?actorId=&from=`);

    const res = await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, TEST_ORG_UUID, { eventsRepo: mockRepo });
    expect(res.status).toBe(200);
    expect(capturedFilters).toEqual({});
  });

  it("PERF4: deny never leaks audit data even though read runs in parallel with authz", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    // The read is started concurrently with the authz fetch; on deny it must be
    // discarded. Assert the denied response carries neither the audit data nor
    // the raw org UUID.
    const mockEntry = {
      id: "aud-leak-check",
      eventId: "evt-leak-check",
      orgId: TEST_ORG_UUID,
      projectId: null,
      environmentId: null,
      actorType: "user",
      actorId: TEST_ACTOR_ID,
      eventType: "invite.created",
      eventVersion: 1,
      source: "membership-worker",
      subjectKind: "invitation",
      subjectId: "c1d2e3f4-a5b6-7890-cdef-123456789012",
      subjectName: "leaked-subject-name",
      category: "membership",
      description: "SHOULD-NOT-LEAK-description",
      occurredAt: new Date("2026-05-26T10:00:00.000Z"),
      requestId: TEST_REQUEST_ID,
      correlationId: null,
      payload: {},
      redactPaths: [],
      createdAt: new Date("2026-05-26T10:00:00.000Z"),
    };

    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async () => ({
        ok: true as const,
        value: { items: [mockEntry], nextCursor: null },
      }),
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv({
      POLICY_WORKER: createMockFetcher(async () =>
        Response.json({ data: { allow: false, reason: "no_matching_role", policyVersion: 1, derivedScope: { orgId: TEST_ORG_UUID } } }),
      ),
    });
    const req = makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`);

    const res = await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, TEST_ORG_UUID, { eventsRepo: mockRepo });

    expect(res.status).toBe(404);
    const raw = await res.text();
    expect(raw).not.toContain("SHOULD-NOT-LEAK-description");
    expect(raw).not.toContain("leaked-subject-name");
    expect(raw).not.toContain("auditEntries");
    expect(raw).not.toContain(TEST_ORG_UUID);
  });

  it("PERF4: emits a Server-Timing header with authctx/db/policy/total phases", async () => {
    const { handleListAudit } = await import("@events-worker/handlers/list-audit");

    const mockRepo: EventsRepository = {
      appendEvent: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      appendEventWithAudit: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      queryAuditByOrg: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryAuditByTarget: async () => ({ ok: true as const, value: { items: [], nextCursor: null } }),
      queryEventsByOrg: async () => ({ ok: false as const, error: { kind: "internal" as const, message: "" } }),
      getEventById: async () => ({ ok: true as const, value: null }),
    };

    const env = createEnv();
    const req = makeRequest(`/v1/organizations/${TEST_ORG_PUBLIC_ID}/audit`);

    const res = await handleListAudit(req, env, TEST_REQUEST_ID, { subjectId: TEST_ACTOR_ID, subjectType: "user" }, TEST_ORG_UUID, { eventsRepo: mockRepo });

    expect(res.status).toBe(200);
    const timing = res.headers.get("Server-Timing");
    expect(timing).toBeTruthy();
    for (const phase of ["authctx", "db", "policy", "total"]) {
      expect(timing).toContain(phase);
    }
  });
});
