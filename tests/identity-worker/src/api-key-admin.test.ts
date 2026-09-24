/// <reference types="@cloudflare/workers-types" />
import { createFakeRepository } from "./helpers/fake-repository";
import { asUuid } from "@saas/db";
import crypto from "node:crypto";
import type { Env } from "../../../apps/identity-worker/src/env";
import type {
  PublicApiKey,
  PublicApiKeyCreateResult,
  PublicApiKeyRevokeResult,
} from "@saas/contracts/api-keys";
import type {
  EventsRepository,
  EventsResult,
  EventsPagedResult,
  StoredEvent,
  StoredAuditEntry,
  AppendEventInput,
  AppendEventWithAuditInput,
} from "@saas/db/events";

interface GlobalCryptoLike {
  crypto?: { subtle?: unknown; randomUUID?: () => string };
}
const g: GlobalCryptoLike = globalThis;
if (!g.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: crypto.webcrypto });
}
if (typeof g.crypto?.randomUUID !== "function") {
  (g.crypto as { randomUUID: () => string }).randomUUID = () => crypto.randomUUID();
}

import {
  handleCreateApiKey,
  handleListApiKeys,
  handleRevokeApiKey,
} from "../../../apps/identity-worker/src/handlers/api-key-admin";

// Public org ids are `org_<32 hex>`; identity/membership persistence keys
// org_id as a bare UUID. The handler must decode the former into the latter
// before any DB/service call. ORG_PUB decodes to ORG_UUID.
const ORG_PUB = "org_" + "a".repeat(32);
const ORG_UUID = asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
// Actor (user) public id `usr_<32 hex>` decodes to a UUID for the UUID-typed
// columns created_by / revoked_by / security_events.user_id.
const ACTOR_PUB = "usr_" + "c".repeat(32);
const ACTOR_UUID = asUuid("cccccccc-cccc-cccc-cccc-cccccccccccc");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface JsonErrorEnvelope {
  error: {
    code: string;
    message?: string;
    details: { fields: Record<string, unknown> };
  };
}

interface JsonCreateResp extends Partial<JsonErrorEnvelope> {
  data: { apiKey: PublicApiKeyCreateResult };
}

interface JsonListResp extends Partial<JsonErrorEnvelope> {
  data: { apiKeys: PublicApiKey[] };
}

interface JsonRevokeResp extends Partial<JsonErrorEnvelope> {
  data: { apiKey: PublicApiKeyRevokeResult };
}

interface JsonValidationResp {
  error: {
    code: string;
    message?: string;
    details: { fields: Record<string, unknown> };
  };
}

function createMockFetcher(
  handler?: (url: string, init: RequestInit) => Promise<Response>,
): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher: Fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const i = init ?? {};
      calls.push({ url, init: i });
      if (handler) return handler(url, i);
      return Promise.resolve(Response.json({ data: {} }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as Fetcher;
  return { fetcher, calls };
}

interface FakeEventsRepo extends EventsRepository {
  events: Array<AppendEventInput | AppendEventWithAuditInput>;
}

/** Creates a fake EventsRepository with appendEventWithAudit */
function createFakeEventsRepo(): FakeEventsRepo {
  const events: Array<AppendEventInput | AppendEventWithAuditInput> = [];
  return {
    events,
    async appendEvent(input: AppendEventInput): Promise<EventsResult<StoredEvent>> {
      events.push(input);
      return {
        ok: true as const,
        value: {
          id: input.id,
          type: input.type,
          version: input.version,
          source: input.source,
          occurredAt: input.occurredAt,
          actorType: input.actorType,
          actorId: input.actorId,
          actorSessionId: input.actorSessionId ?? null,
          actorIp: input.actorIp ?? null,
          orgId: input.orgId,
          projectId: input.projectId ?? null,
          environmentId: input.environmentId ?? null,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          subjectName: input.subjectName ?? null,
          requestId: input.requestId,
          correlationId: input.correlationId ?? null,
          causationId: input.causationId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          payload: input.payload,
          redactPaths: input.redactPaths ?? [],
          createdAt: new Date(),
        },
      };
    },
    async appendEventWithAudit(
      input: AppendEventWithAuditInput,
    ): Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>> {
      events.push(input);
      const e = input.event;
      const a = input.audit;
      return {
        ok: true as const,
        value: {
          event: {
            id: e.id,
            type: e.type,
            version: e.version,
            source: e.source,
            occurredAt: e.occurredAt,
            actorType: e.actorType,
            actorId: e.actorId,
            actorSessionId: e.actorSessionId ?? null,
            actorIp: e.actorIp ?? null,
            orgId: e.orgId,
            projectId: e.projectId ?? null,
            environmentId: e.environmentId ?? null,
            subjectKind: e.subjectKind,
            subjectId: e.subjectId,
            subjectName: e.subjectName ?? null,
            requestId: e.requestId,
            correlationId: e.correlationId ?? null,
            causationId: e.causationId ?? null,
            idempotencyKey: e.idempotencyKey ?? null,
            payload: e.payload,
            redactPaths: e.redactPaths ?? [],
            createdAt: new Date(),
          },
          audit: {
            id: a.id,
            eventId: e.id,
            orgId: e.orgId,
            projectId: a.projectId ?? null,
            environmentId: a.environmentId ?? null,
            actorType: e.actorType,
            actorId: e.actorId,
            eventType: e.type,
            eventVersion: e.version,
            source: e.source,
            subjectKind: e.subjectKind,
            subjectId: e.subjectId,
            subjectName: e.subjectName ?? null,
            category: a.category ?? "",
            description: a.description ?? "",
            occurredAt: e.occurredAt,
            requestId: e.requestId,
            correlationId: e.correlationId ?? null,
            payload: e.payload,
            redactPaths: e.redactPaths ?? [],
            createdAt: new Date(),
          },
        },
      };
    },
    async queryAuditByOrg(): Promise<EventsResult<EventsPagedResult<StoredAuditEntry>>> {
      return { ok: true as const, value: { items: [], nextCursor: null } };
    },
    async queryAuditByTarget(): Promise<EventsResult<EventsPagedResult<StoredAuditEntry>>> {
      return { ok: true as const, value: { items: [], nextCursor: null } };
    },
    async queryEventsByOrg(): Promise<EventsResult<StoredEvent[]>> {
      return { ok: true as const, value: [] };
    },
    async getEventById(): Promise<EventsResult<StoredEvent | null>> {
      return { ok: true as const, value: null };
    },
  };
}

function makeEnv(membershipFetcher: Fetcher, policyFetcher: Fetcher): Env {
  return {
    PLATFORM_DB: {} as D1Database,
    MEMBERSHIP_WORKER: membershipFetcher,
    POLICY_WORKER: policyFetcher,
    ENVIRONMENT: "test",
  } as Env;
}

/** Standard membership + policy fetcher that approves everything */
function createApprovingFetchers(): {
  membershipFetcher: Fetcher;
  membershipCalls: FetchCall[];
  policyFetcher: Fetcher;
  policyCalls: FetchCall[];
} {
  const { fetcher: membershipFetcher, calls: membershipCalls } = createMockFetcher(async (url) => {
    if (url.includes("/authorization-context")) {
      return Response.json({
        data: {
          memberships: [
            { kind: "role_assignment", role: "owner", scope: { kind: "organization", orgId: ORG_UUID } },
          ],
        },
      });
    }
    if (url.includes("/service-principal-bindings")) {
      return Response.json({ data: { id: "bind_1" } });
    }
    return Response.json({ data: {} });
  });

  const { fetcher: policyFetcher, calls: policyCalls } = createMockFetcher(async () => {
    return Response.json({ data: { allow: true, reason: "org_owner", policyVersion: 1 } });
  });

  return { membershipFetcher, membershipCalls, policyFetcher, policyCalls };
}

function makeCreateRequest(orgId: string, body: object, actorHeaders = true): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (actorHeaders) {
    headers["x-actor-subject-id"] = ACTOR_PUB;
    headers["x-actor-subject-type"] = "user";
  }
  return new Request(`https://identity.internal/v1/organizations/${orgId}/api-keys`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeListRequest(orgId: string, actorHeaders = true): Request {
  const headers: Record<string, string> = {};
  if (actorHeaders) {
    headers["x-actor-subject-id"] = ACTOR_PUB;
    headers["x-actor-subject-type"] = "user";
  }
  return new Request(`https://identity.internal/v1/organizations/${orgId}/api-keys`, {
    method: "GET",
    headers,
  });
}

function makeRevokeRequest(orgId: string, keyId: string, actorHeaders = true): Request {
  const headers: Record<string, string> = {};
  if (actorHeaders) {
    headers["x-actor-subject-id"] = ACTOR_PUB;
    headers["x-actor-subject-type"] = "user";
  }
  return new Request(`https://identity.internal/v1/organizations/${orgId}/api-keys/${keyId}`, {
    method: "DELETE",
    headers,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleCreateApiKey", () => {
  it("returns 401 if no actor headers", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleCreateApiKey(
      makeCreateRequest(ORG_PUB, { label: "test", role: "admin" }, false),
      makeEnv(membershipFetcher, policyFetcher),
      "req_1",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(401);
  });

  it("returns 422 if label is missing", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleCreateApiKey(
      makeCreateRequest(ORG_PUB, { role: "admin" }),
      makeEnv(membershipFetcher, policyFetcher),
      "req_2",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(422);
    const json = (await response.json()) as JsonValidationResp;
    expect(json.error.details.fields.label).toBeDefined();
  });

  it("returns 422 if label is too long", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleCreateApiKey(
      makeCreateRequest(ORG_PUB, { label: "x".repeat(129), role: "admin" }),
      makeEnv(membershipFetcher, policyFetcher),
      "req_2b",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(422);
  });

  it("returns 422 if role is invalid", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleCreateApiKey(
      makeCreateRequest(ORG_PUB, { label: "test", role: "superadmin" }),
      makeEnv(membershipFetcher, policyFetcher),
      "req_3",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(422);
    const json = (await response.json()) as JsonValidationResp;
    expect(json.error.details.fields.role).toBeDefined();
  });

  it("returns 422 if project role without projectId", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleCreateApiKey(
      makeCreateRequest(ORG_PUB, { label: "test", role: "project_admin" }),
      makeEnv(membershipFetcher, policyFetcher),
      "req_4",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(422);
    const json = (await response.json()) as JsonValidationResp;
    expect(json.error.details.fields.projectId).toBeDefined();
  });

  it("returns 404 if membership context fails", async () => {
    const { fetcher: membershipFetcher } = createMockFetcher(async (url) => {
      if (url.includes("/authorization-context")) {
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      }
      return Response.json({ data: {} });
    });
    const { fetcher: policyFetcher } = createMockFetcher(async () =>
      Response.json({ data: { allow: true, reason: "ok", policyVersion: 1 } }),
    );
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleCreateApiKey(
      makeCreateRequest(ORG_PUB, { label: "test", role: "admin" }),
      makeEnv(membershipFetcher, policyFetcher),
      "req_5",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 if policy denies", async () => {
    const { fetcher: membershipFetcher } = createMockFetcher(async (url) => {
      if (url.includes("/authorization-context")) {
        return Response.json({
          data: {
            memberships: [
              { kind: "role_assignment", role: "viewer", scope: { kind: "organization", orgId: ORG_UUID } },
            ],
          },
        });
      }
      return Response.json({ data: {} });
    });
    const { fetcher: policyFetcher } = createMockFetcher(async () =>
      Response.json({ data: { allow: false, reason: "denied", policyVersion: 1 } }),
    );
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleCreateApiKey(
      makeCreateRequest(ORG_PUB, { label: "test", role: "admin" }),
      makeEnv(membershipFetcher, policyFetcher),
      "req_6",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(404);
  });

  it("returns 201 with api key data on success", async () => {
    const { membershipFetcher } = createApprovingFetchers();
    const { fetcher: policyFetcher } = createMockFetcher(async () =>
      Response.json({ data: { allow: true, reason: "org_owner", policyVersion: 1 } }),
    );
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleCreateApiKey(
      makeCreateRequest(ORG_PUB, { label: "My Key", role: "admin" }),
      makeEnv(membershipFetcher, policyFetcher),
      "req_7",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(201);
    const json = (await response.json()) as JsonCreateResp;
    const apiKey = json.data.apiKey;
    expect(apiKey.secret).toMatch(/^sk_/);
    expect(apiKey.prefix).toBe(apiKey.secret.slice(0, 12));
    expect(apiKey.label).toBe("My Key");
    expect(apiKey.servicePrincipal).toBeDefined();
    expect(apiKey.servicePrincipal.role).toBe("admin");

    // SP was created in the repo
    expect(repo._servicePrincipals.size).toBe(1);

    // Security event was recorded
    const secEvents = repo._securityEvents.filter((e) => e.eventType === "api_key.created");
    expect(secEvents).toHaveLength(1);

    // Org event was appended
    expect(eventsRepo.events.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 422 for a malformed (non-UUID) org id", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    // `org_1` is a valid prefix but not `org_<32 hex>` — it must be rejected
    // before any downstream membership/DB call (regression for the UUID-cast
    // crash that surfaced as a generic "Create failed").
    const response = await handleCreateApiKey(
      makeCreateRequest("org_1", { label: "test", role: "admin" }),
      makeEnv(membershipFetcher, policyFetcher),
      "req_bad_org",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(422);
    expect(repo._servicePrincipals.size).toBe(0);
    expect(eventsRepo.events.length).toBe(0);
  });

  it("forwards the decoded UUID (not the public org id) to authorization-context", async () => {
    const { membershipFetcher, membershipCalls } = createApprovingFetchers();
    const { fetcher: policyFetcher } = createMockFetcher(async () =>
      Response.json({ data: { allow: true, reason: "org_owner", policyVersion: 1 } }),
    );
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleCreateApiKey(
      makeCreateRequest(ORG_PUB, { label: "My Key", role: "admin" }),
      makeEnv(membershipFetcher, policyFetcher),
      "req_decode",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(201);

    const ctxCall = membershipCalls.find((c) => c.url.includes("/authorization-context"));
    expect(ctxCall).toBeDefined();
    const body = JSON.parse(ctxCall!.init.body as string) as { orgId: string };
    expect(body.orgId).toBe(ORG_UUID);

    // The SP + key were persisted under the decoded UUIDs, not the public ids:
    // org_id and created_by are UUID columns.
    const sp = [...repo._servicePrincipals.values()][0] as { orgId: string; createdBy: string };
    expect(sp.orgId).toBe(ORG_UUID);
    expect(sp.createdBy).toBe(ACTOR_UUID);
  });

  it("returns 422 for a malformed actor id", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    // Valid org id, but the actor header is not a `usr_<32 hex>` form.
    const req = makeCreateRequest(ORG_PUB, { label: "test", role: "admin" });
    req.headers.set("x-actor-subject-id", "usr_short");

    const response = await handleCreateApiKey(
      req,
      makeEnv(membershipFetcher, policyFetcher),
      "req_bad_actor",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(422);
    expect(repo._servicePrincipals.size).toBe(0);
  });

  it("decodes a project-scoped key's public projectId to a UUID", async () => {
    const PRJ_PUB = "prj_" + "d".repeat(32);
    const PRJ_UUID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleCreateApiKey(
      makeCreateRequest(ORG_PUB, { label: "ci", role: "project_admin", projectId: PRJ_PUB }),
      makeEnv(membershipFetcher, policyFetcher),
      "req_prj",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(201);
    // service_principals.project_id is a UUID column — must be the decoded form.
    const sp = [...repo._servicePrincipals.values()][0] as { projectId: string | null };
    expect(sp.projectId).toBe(PRJ_UUID);
  });

  it("returns 422 for a malformed project id", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleCreateApiKey(
      makeCreateRequest(ORG_PUB, { label: "ci", role: "project_admin", projectId: "prj_bad" }),
      makeEnv(membershipFetcher, policyFetcher),
      "req_prj_bad",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(422);
    expect(repo._servicePrincipals.size).toBe(0);
  });
});

describe("handleListApiKeys", () => {
  it("returns 401 if no actor headers", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();

    const response = await handleListApiKeys(
      makeListRequest(ORG_PUB, false),
      makeEnv(membershipFetcher, policyFetcher),
      "req_l1",
      { identityRepo: repo },
    );
    expect(response.status).toBe(401);
  });

  it("returns 200 with empty list when no keys exist", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();

    const response = await handleListApiKeys(
      makeListRequest(ORG_PUB),
      makeEnv(membershipFetcher, policyFetcher),
      "req_l2",
      { identityRepo: repo },
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as JsonListResp;
    expect(json.data.apiKeys).toEqual([]);
  });

  it("returns 200 with keys after creating one", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const now = new Date();

    // Add a SP and API key directly to the repo
    await repo.createServicePrincipal({
      id: "sp_1",
      orgId: ORG_UUID,
      projectId: null,
      displayName: "API Key: test-key",
      createdBy: ACTOR_UUID,
      createdAt: now,
    });
    await repo.createApiKey({
      id: "key_1",
      servicePrincipalId: "sp_1",
      orgId: ORG_UUID,
      keyPrefix: "***",
      keyHash: "hash_1",
      label: "test-key",
      expiresAt: null,
      createdBy: ACTOR_UUID,
      createdAt: now,
    });

    const response = await handleListApiKeys(
      makeListRequest(ORG_PUB),
      makeEnv(membershipFetcher, policyFetcher),
      "req_l3",
      { identityRepo: repo },
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as JsonListResp;
    expect(json.data.apiKeys).toHaveLength(1);
    expect(json.data.apiKeys[0]!.id).toBe("key_1");
    expect(json.data.apiKeys[0]!.label).toBe("test-key");
  });
});

describe("handleRevokeApiKey", () => {
  it("returns 401 if no actor headers", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleRevokeApiKey(
      makeRevokeRequest(ORG_PUB, "key_1", false),
      makeEnv(membershipFetcher, policyFetcher),
      "req_r1",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(401);
  });

  it("returns 404 if key does not exist", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();

    const response = await handleRevokeApiKey(
      makeRevokeRequest(ORG_PUB, "key_nonexistent"),
      makeEnv(membershipFetcher, policyFetcher),
      "req_r2",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(404);
  });

  it("returns 409 if already revoked", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();
    const now = new Date();

    await repo.createServicePrincipal({
      id: "sp_r",
      orgId: ORG_UUID,
      projectId: null,
      displayName: "API Key: revoked-key",
      createdBy: ACTOR_UUID,
      createdAt: now,
    });
    await repo.createApiKey({
      id: "key_revoked",
      servicePrincipalId: "sp_r",
      orgId: ORG_UUID,
      keyPrefix: "***",
      keyHash: "hash_r",
      label: "revoked-key",
      expiresAt: null,
      createdBy: ACTOR_UUID,
      createdAt: now,
    });
    // Revoke it
    await repo.revokeApiKey("key_revoked", ACTOR_UUID, now);

    const response = await handleRevokeApiKey(
      makeRevokeRequest(ORG_PUB, "key_revoked"),
      makeEnv(membershipFetcher, policyFetcher),
      "req_r3",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(409);
  });

  it("returns 200 on success with revoked key data", async () => {
    const { membershipFetcher, policyFetcher } = createApprovingFetchers();
    const repo = createFakeRepository();
    const eventsRepo = createFakeEventsRepo();
    const now = new Date();

    await repo.createServicePrincipal({
      id: "sp_s",
      orgId: ORG_UUID,
      projectId: null,
      displayName: "API Key: active-key",
      createdBy: ACTOR_UUID,
      createdAt: now,
    });
    await repo.createApiKey({
      id: "key_active",
      servicePrincipalId: "sp_s",
      orgId: ORG_UUID,
      keyPrefix: "***",
      keyHash: "hash_s",
      label: "active-key",
      expiresAt: null,
      createdBy: ACTOR_UUID,
      createdAt: now,
    });

    const response = await handleRevokeApiKey(
      makeRevokeRequest(ORG_PUB, "key_active"),
      makeEnv(membershipFetcher, policyFetcher),
      "req_r4",
      { identityRepo: repo, eventsRepo },
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as JsonRevokeResp;
    expect(json.data.apiKey.id).toBe("key_active");
    expect(json.data.apiKey.label).toBe("active-key");
    expect(json.data.apiKey.revokedAt).toBeDefined();
  });
});
