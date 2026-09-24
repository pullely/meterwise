import { handleCreateSetting } from "@config-worker/handlers/create-setting";
import { handleUpdateSetting } from "@config-worker/handlers/update-setting";
import { handleCreateFeatureFlag } from "@config-worker/handlers/create-feature-flag";
import { handleUpdateFeatureFlag } from "@config-worker/handlers/update-feature-flag";
import { parseSettingPublicId, parseFeatureFlagPublicId } from "@config-worker/ids";
import type { Env } from "@config-worker/env";
import type { ActorContext } from "@config-worker/router";
import type {
  Scope,
  Setting,
  FeatureFlag,
  ConfigResult,
} from "@saas/db/config";
import type {
  AppendEventWithAuditInput,
  EventsResult,
  StoredEvent,
  StoredAuditEntry,
} from "@saas/db/events";

// ── Constants ──────────────────────────────────────────────
const TEST_ORG_UUID = "11111111-1111-1111-1111-111111111111";
const TEST_PROJECT_UUID = "22222222-2222-2222-2222-222222222222";
const TEST_ENV_UUID = "44444444-4444-4444-4444-444444444444";
const TEST_USER_ID = "usr_aabbccdd";
const FIXED_NOW = new Date("2026-05-01T00:00:00Z");
const FIXED_ID = "deadbeef01234567";

const ACTOR: ActorContext = { subjectId: TEST_USER_ID, subjectType: "user" };
const ORG_SCOPE: Scope = { kind: "organization", orgId: TEST_ORG_UUID };
const PRJ_SCOPE: Scope = { kind: "project", orgId: TEST_ORG_UUID, projectId: TEST_PROJECT_UUID };

const FAKE_ENV = {} as Env;

// ── Local types ────────────────────────────────────────────
type SettingView = {
  id: string;
  key: string;
  value: unknown;
};
type FeatureFlagView = {
  id: string;
  flagKey: string;
  enabled: boolean;
  value?: unknown;
};
type ErrorEnvelope = {
  code: string;
  message?: string;
  details?: { fields?: Record<string, unknown> };
};
type JsonResp = {
  data: {
    setting?: SettingView;
    featureFlag?: FeatureFlagView;
  };
  error: ErrorEnvelope;
};

// ── Reusable typed stubs ───────────────────────────────────
/** A `ConfigResult` failure used to satisfy mock repo slots that should
 * never actually be invoked under the test's branching. */
const unusedConfigFailure = <T>(): Promise<ConfigResult<T>> =>
  Promise.resolve({
    ok: false,
    error: { kind: "internal", message: "unused stub" },
  });

const PLACEHOLDER_EVENT: StoredEvent = {
  id: "evt_placeholder",
  type: "test.placeholder",
  version: 1,
  source: "config-worker-tests",
  occurredAt: FIXED_NOW,
  actorType: "user",
  actorId: TEST_USER_ID,
  actorSessionId: null,
  actorIp: null,
  orgId: TEST_ORG_UUID,
  projectId: null,
  environmentId: null,
  subjectKind: "test",
  subjectId: "placeholder",
  subjectName: null,
  requestId: "req_placeholder",
  correlationId: null,
  causationId: null,
  idempotencyKey: null,
  payload: {},
  redactPaths: [],
  createdAt: FIXED_NOW,
};

const PLACEHOLDER_AUDIT: StoredAuditEntry = {
  id: "aud_placeholder",
  eventId: "evt_placeholder",
  orgId: TEST_ORG_UUID,
  projectId: null,
  environmentId: null,
  actorType: "user",
  actorId: TEST_USER_ID,
  eventType: "test.placeholder",
  eventVersion: 1,
  source: "config-worker-tests",
  subjectKind: "test",
  subjectId: "placeholder",
  subjectName: null,
  category: "test",
  description: "placeholder",
  occurredAt: FIXED_NOW,
  requestId: "req_placeholder",
  correlationId: null,
  payload: {},
  redactPaths: [],
  createdAt: FIXED_NOW,
};

function makeJsonRequest(body: unknown): Request {
  return new Request("https://config-worker/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeBadRequest(): Request {
  return new Request("https://config-worker/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
}

// ── Fake Setting ───────────────────────────────────────────
function fakeSetting(overrides?: Partial<Setting>): Setting {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    orgId: TEST_ORG_UUID,
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    key: "max.users",
    value: 100,
    description: "Maximum users",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

function fakeFlag(overrides?: Partial<FeatureFlag>): FeatureFlag {
  return {
    id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    orgId: TEST_ORG_UUID,
    projectId: null,
    environmentId: null,
    scopeKind: "organization",
    flagKey: "dark_mode",
    enabled: false,
    value: null,
    description: "Dark mode toggle",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

// ── Fake repos ─────────────────────────────────────────────
type FakeEventsRepo = {
  calls: AppendEventWithAuditInput[];
  appendEventWithAudit: (
    input: AppendEventWithAuditInput,
  ) => Promise<EventsResult<{ event: StoredEvent; audit: StoredAuditEntry }>>;
};

function fakeEventsRepo(): FakeEventsRepo {
  const calls: AppendEventWithAuditInput[] = [];
  return {
    calls,
    appendEventWithAudit(input) {
      calls.push(input);
      return Promise.resolve({
        ok: true as const,
        value: { event: PLACEHOLDER_EVENT, audit: PLACEHOLDER_AUDIT },
      });
    },
  };
}

// ── createSetting tests ────────────────────────────────────
describe("handleCreateSetting", () => {
  it("returns 400 for invalid JSON", async () => {
    const res = await handleCreateSetting(makeBadRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: { createSetting: () => unusedConfigFailure<Setting>() },
    });
    expect(res.status).toBe(400);
  });

  it("returns validation error for missing key", async () => {
    const res = await handleCreateSetting(makeJsonRequest({ value: 42 }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: { createSetting: () => unusedConfigFailure<Setting>() },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as JsonResp;
    expect(body.error.details?.fields?.key).toBeDefined();
  });

  it("returns validation error for invalid key pattern", async () => {
    const res = await handleCreateSetting(makeJsonRequest({ key: "123bad" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: { createSetting: () => unusedConfigFailure<Setting>() },
    });
    expect(res.status).toBe(422);
  });

  it("creates setting successfully", async () => {
    const setting = fakeSetting();
    const eventsRepo = fakeEventsRepo();
    const res = await handleCreateSetting(
      makeJsonRequest({ key: "max.users", value: 100, description: "Max users" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSetting: () => Promise.resolve({ ok: true as const, value: setting }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as JsonResp;
    expect(body.data.setting!.key).toBe("max.users");
    expect(body.data.setting!.id).toMatch(/^stg_/);
    expect(eventsRepo.calls).toHaveLength(1);
  });

  it("returns 409 on conflict", async () => {
    const res = await handleCreateSetting(
      makeJsonRequest({ key: "dup.key", value: "x" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createSetting: () => Promise.resolve({ ok: false as const, error: { kind: "conflict" as const, entity: "setting" } }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(409);
  });
});

// ── updateSetting tests ────────────────────────────────────
describe("handleUpdateSetting", () => {
  const SETTING_UUID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  it("returns 400 for invalid JSON", async () => {
    const res = await handleUpdateSetting(makeBadRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SETTING_UUID, {
      repo: {
        getSetting: () => unusedConfigFailure<Setting>(),
        updateSetting: () => unusedConfigFailure<Setting>(),
      },
    });
    expect(res.status).toBe(400);
  });

  it("returns validation error when no fields provided", async () => {
    const res = await handleUpdateSetting(makeJsonRequest({}), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SETTING_UUID, {
      repo: {
        getSetting: () => unusedConfigFailure<Setting>(),
        updateSetting: () => unusedConfigFailure<Setting>(),
      },
    });
    expect(res.status).toBe(422);
  });

  it("updates setting successfully", async () => {
    const updated = fakeSetting({ value: 200 });
    const eventsRepo = fakeEventsRepo();
    const res = await handleUpdateSetting(
      makeJsonRequest({ value: 200 }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SETTING_UUID,
      {
        repo: {
          getSetting: () => Promise.resolve({ ok: true as const, value: fakeSetting() }),
          updateSetting: () => Promise.resolve({ ok: true as const, value: updated }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonResp;
    expect(body.data.setting!.value).toBe(200);
    expect(eventsRepo.calls).toHaveLength(1);
  });

  it("returns 404 when setting not found", async () => {
    const res = await handleUpdateSetting(
      makeJsonRequest({ value: 200 }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SETTING_UUID,
      {
        repo: {
          getSetting: () => Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } }),
          updateSetting: () => Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when org route targets project-scoped setting", async () => {
    const projectSetting = fakeSetting({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const res = await handleUpdateSetting(
      makeJsonRequest({ value: 200 }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, SETTING_UUID,
      {
        repo: {
          getSetting: () => Promise.resolve({ ok: true as const, value: projectSetting }),
          updateSetting: () => Promise.resolve({ ok: true as const, value: projectSetting }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when project route targets org-scoped setting", async () => {
    const orgSetting = fakeSetting();
    const res = await handleUpdateSetting(
      makeJsonRequest({ value: 200 }),
      FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, SETTING_UUID,
      {
        repo: {
          getSetting: () => Promise.resolve({ ok: true as const, value: orgSetting }),
          updateSetting: () => Promise.resolve({ ok: true as const, value: orgSetting }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when project route has mismatched projectId", async () => {
    const OTHER_PROJECT = "33333333-3333-3333-3333-333333333333";
    const projectSetting = fakeSetting({ scopeKind: "project", projectId: OTHER_PROJECT });
    const res = await handleUpdateSetting(
      makeJsonRequest({ value: 200 }),
      FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, SETTING_UUID,
      {
        repo: {
          getSetting: () => Promise.resolve({ ok: true as const, value: projectSetting }),
          updateSetting: () => Promise.resolve({ ok: true as const, value: projectSetting }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(404);
  });

  it("succeeds when project route matches project-scoped setting", async () => {
    const projectSetting = fakeSetting({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const eventsRepo = fakeEventsRepo();
    const res = await handleUpdateSetting(
      makeJsonRequest({ value: 200 }),
      FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, SETTING_UUID,
      {
        repo: {
          getSetting: () => Promise.resolve({ ok: true as const, value: projectSetting }),
          updateSetting: () => Promise.resolve({ ok: true as const, value: { ...projectSetting, value: 200 } }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 when environment route targets project-scoped setting", async () => {
    const projectSetting = fakeSetting({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const ENV_SCOPE: Scope = { kind: "environment", orgId: TEST_ORG_UUID, projectId: TEST_PROJECT_UUID, environmentId: TEST_ENV_UUID };
    const res = await handleUpdateSetting(
      makeJsonRequest({ value: 200 }),
      FAKE_ENV, "req1", ACTOR, ENV_SCOPE, SETTING_UUID,
      {
        repo: {
          getSetting: () => Promise.resolve({ ok: true as const, value: projectSetting }),
          updateSetting: () => Promise.resolve({ ok: true as const, value: projectSetting }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(404);
  });
});

// ── createFeatureFlag tests ────────────────────────────────
describe("handleCreateFeatureFlag", () => {
  it("returns 400 for invalid JSON", async () => {
    const res = await handleCreateFeatureFlag(makeBadRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: { createFeatureFlag: () => unusedConfigFailure<FeatureFlag>() },
    });
    expect(res.status).toBe(400);
  });

  it("returns validation error for missing flagKey", async () => {
    const res = await handleCreateFeatureFlag(makeJsonRequest({ enabled: true }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: { createFeatureFlag: () => unusedConfigFailure<FeatureFlag>() },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as JsonResp;
    expect(body.error.details?.fields?.flagKey).toBeDefined();
  });

  it("returns validation error for non-boolean enabled", async () => {
    const res = await handleCreateFeatureFlag(makeJsonRequest({ flagKey: "feat.x", enabled: "yes" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, {
      repo: { createFeatureFlag: () => unusedConfigFailure<FeatureFlag>() },
    });
    expect(res.status).toBe(422);
  });

  it("creates feature flag successfully", async () => {
    const flag = fakeFlag();
    const eventsRepo = fakeEventsRepo();
    const res = await handleCreateFeatureFlag(
      makeJsonRequest({ flagKey: "dark_mode", enabled: false, description: "Dark mode toggle" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createFeatureFlag: () => Promise.resolve({ ok: true as const, value: flag }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as JsonResp;
    expect(body.data.featureFlag!.flagKey).toBe("dark_mode");
    expect(body.data.featureFlag!.id).toMatch(/^flg_/);
    expect(eventsRepo.calls).toHaveLength(1);
  });

  it("returns 409 on conflict", async () => {
    const res = await handleCreateFeatureFlag(
      makeJsonRequest({ flagKey: "dup.flag" }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE,
      {
        repo: {
          createFeatureFlag: () => Promise.resolve({ ok: false as const, error: { kind: "conflict" as const, entity: "feature_flag" } }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(409);
  });
});

// ── updateFeatureFlag tests ────────────────────────────────
describe("handleUpdateFeatureFlag", () => {
  const FLAG_UUID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

  it("returns 400 for invalid JSON", async () => {
    const res = await handleUpdateFeatureFlag(makeBadRequest(), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, FLAG_UUID, {
      repo: {
        getFeatureFlag: () => unusedConfigFailure<FeatureFlag>(),
        updateFeatureFlag: () => unusedConfigFailure<FeatureFlag>(),
      },
    });
    expect(res.status).toBe(400);
  });

  it("returns validation error when no fields provided", async () => {
    const res = await handleUpdateFeatureFlag(makeJsonRequest({}), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, FLAG_UUID, {
      repo: {
        getFeatureFlag: () => unusedConfigFailure<FeatureFlag>(),
        updateFeatureFlag: () => unusedConfigFailure<FeatureFlag>(),
      },
    });
    expect(res.status).toBe(422);
  });

  it("returns validation error for non-boolean enabled", async () => {
    const res = await handleUpdateFeatureFlag(makeJsonRequest({ enabled: "nope" }), FAKE_ENV, "req1", ACTOR, ORG_SCOPE, FLAG_UUID, {
      repo: {
        getFeatureFlag: () => unusedConfigFailure<FeatureFlag>(),
        updateFeatureFlag: () => unusedConfigFailure<FeatureFlag>(),
      },
    });
    expect(res.status).toBe(422);
  });

  it("updates feature flag successfully", async () => {
    const updated = fakeFlag({ enabled: true });
    const eventsRepo = fakeEventsRepo();
    const res = await handleUpdateFeatureFlag(
      makeJsonRequest({ enabled: true }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, FLAG_UUID,
      {
        repo: {
          getFeatureFlag: () => Promise.resolve({ ok: true as const, value: fakeFlag() }),
          updateFeatureFlag: () => Promise.resolve({ ok: true as const, value: updated }),
        },
        eventsRepo,
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonResp;
    expect(body.data.featureFlag!.enabled).toBe(true);
    expect(eventsRepo.calls).toHaveLength(1);
  });

  it("returns 404 when flag not found", async () => {
    const res = await handleUpdateFeatureFlag(
      makeJsonRequest({ enabled: true }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, FLAG_UUID,
      {
        repo: {
          getFeatureFlag: () => Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } }),
          updateFeatureFlag: () => Promise.resolve({ ok: false as const, error: { kind: "not_found" as const } }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when org route targets project-scoped flag", async () => {
    const projectFlag = fakeFlag({ scopeKind: "project", projectId: TEST_PROJECT_UUID });
    const res = await handleUpdateFeatureFlag(
      makeJsonRequest({ enabled: true }),
      FAKE_ENV, "req1", ACTOR, ORG_SCOPE, FLAG_UUID,
      {
        repo: {
          getFeatureFlag: () => Promise.resolve({ ok: true as const, value: projectFlag }),
          updateFeatureFlag: () => Promise.resolve({ ok: true as const, value: projectFlag }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when project route has mismatched projectId", async () => {
    const OTHER_PROJECT = "33333333-3333-3333-3333-333333333333";
    const projectFlag = fakeFlag({ scopeKind: "project", projectId: OTHER_PROJECT });
    const res = await handleUpdateFeatureFlag(
      makeJsonRequest({ enabled: true }),
      FAKE_ENV, "req1", ACTOR, PRJ_SCOPE, FLAG_UUID,
      {
        repo: {
          getFeatureFlag: () => Promise.resolve({ ok: true as const, value: projectFlag }),
          updateFeatureFlag: () => Promise.resolve({ ok: true as const, value: projectFlag }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when environment route targets org-scoped flag", async () => {
    const orgFlag = fakeFlag();
    const ENV_SCOPE: Scope = { kind: "environment", orgId: TEST_ORG_UUID, projectId: TEST_PROJECT_UUID, environmentId: TEST_ENV_UUID };
    const res = await handleUpdateFeatureFlag(
      makeJsonRequest({ enabled: true }),
      FAKE_ENV, "req1", ACTOR, ENV_SCOPE, FLAG_UUID,
      {
        repo: {
          getFeatureFlag: () => Promise.resolve({ ok: true as const, value: orgFlag }),
          updateFeatureFlag: () => Promise.resolve({ ok: true as const, value: orgFlag }),
        },
        generateId: () => FIXED_ID,
        now: () => FIXED_NOW,
      },
    );
    expect(res.status).toBe(404);
  });
});

// ── Router mutation integration tests ──────────────────────
import { route } from "@config-worker/router";
import { settingPublicId, featureFlagPublicId } from "@config-worker/ids";

const TEST_ORG_PUBLIC = "org_11111111111111111111111111111111";

describe("config-worker router - mutations", () => {
  it("routes POST to org settings (create)", async () => {
    const req = new Request(
      `https://config-worker/v1/organizations/${TEST_ORG_PUBLIC}/config/settings`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_test",
          "x-actor-subject-id": TEST_USER_ID,
          "x-actor-subject-type": "user",
        },
        body: JSON.stringify({ key: "app.name", value: "test" }),
      },
    );
    const env = {} as Env;
    const res = await route(req, env);
    // Will get 503 (no PLATFORM_DB) but route matched — not 404 or 405
    expect(res.status).toBe(503);
  });

  it("routes POST to org feature-flags (create)", async () => {
    const req = new Request(
      `https://config-worker/v1/organizations/${TEST_ORG_PUBLIC}/config/feature-flags`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_test",
          "x-actor-subject-id": TEST_USER_ID,
          "x-actor-subject-type": "user",
        },
        body: JSON.stringify({ flagKey: "test.flag", enabled: true }),
      },
    );
    const env = {} as Env;
    const res = await route(req, env);
    expect(res.status).toBe(503);
  });

  it("routes PATCH to org setting item (update)", async () => {
    const itemPublicId = settingPublicId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const req = new Request(
      `https://config-worker/v1/organizations/${TEST_ORG_PUBLIC}/config/settings/${itemPublicId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_test",
          "x-actor-subject-id": TEST_USER_ID,
          "x-actor-subject-type": "user",
        },
        body: JSON.stringify({ value: 999 }),
      },
    );
    const env = {} as Env;
    const res = await route(req, env);
    expect(res.status).toBe(503);
  });

  it("routes PATCH to org feature-flag item (update)", async () => {
    const itemPublicId = featureFlagPublicId("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    const req = new Request(
      `https://config-worker/v1/organizations/${TEST_ORG_PUBLIC}/config/feature-flags/${itemPublicId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_test",
          "x-actor-subject-id": TEST_USER_ID,
          "x-actor-subject-type": "user",
        },
        body: JSON.stringify({ enabled: true }),
      },
    );
    const env = {} as Env;
    const res = await route(req, env);
    expect(res.status).toBe(503);
  });

  it("routes POST to org secrets (create) — returns 503 without DB", async () => {
    const req = new Request(
      `https://config-worker/v1/organizations/${TEST_ORG_PUBLIC}/config/secrets`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_test",
          "x-actor-subject-id": TEST_USER_ID,
          "x-actor-subject-type": "user",
        },
        body: JSON.stringify({ secretKey: "API_KEY" }),
      },
    );
    const env = {} as Env;
    const res = await route(req, env);
    expect(res.status).toBe(503);
  });

  it("returns 401 for POST without actor headers", async () => {
    const req = new Request(
      `https://config-worker/v1/organizations/${TEST_ORG_PUBLIC}/config/settings`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "x", value: 1 }),
      },
    );
    const env = {} as Env;
    const res = await route(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 404 for PATCH with malformed setting ID", async () => {
    const req = new Request(
      `https://config-worker/v1/organizations/${TEST_ORG_PUBLIC}/config/settings/bad_id`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-request-id": "req_test",
          "x-actor-subject-id": TEST_USER_ID,
          "x-actor-subject-type": "user",
        },
        body: JSON.stringify({ value: 1 }),
      },
    );
    const env = {} as Env;
    const res = await route(req, env);
    expect(res.status).toBe(404);
  });

  it("returns 405 for GET on item route", async () => {
    const itemPublicId = settingPublicId("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    const req = new Request(
      `https://config-worker/v1/organizations/${TEST_ORG_PUBLIC}/config/settings/${itemPublicId}`,
      {
        method: "GET",
        headers: {
          "x-request-id": "req_test",
          "x-actor-subject-id": TEST_USER_ID,
          "x-actor-subject-type": "user",
        },
      },
    );
    const env = {} as Env;
    const res = await route(req, env);
    expect(res.status).toBe(405);
  });
});

// ── parseSettingPublicId / parseFeatureFlagPublicId tests ───
describe("parseSettingPublicId", () => {
  it("parses valid stg_ ID", () => {
    const uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const publicId = settingPublicId(uuid);
    expect(parseSettingPublicId(publicId)).toBe(uuid);
  });

  it("returns null for wrong prefix", () => {
    expect(parseSettingPublicId("flg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });
});

describe("parseFeatureFlagPublicId", () => {
  it("parses valid flg_ ID", () => {
    const uuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const publicId = featureFlagPublicId(uuid);
    expect(parseFeatureFlagPublicId(publicId)).toBe(uuid);
  });

  it("returns null for wrong prefix", () => {
    expect(parseFeatureFlagPublicId("stg_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBeNull();
  });
});
