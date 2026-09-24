import { handleListSupportActions } from "@admin-worker/handlers/list-support-actions";
import type { ListSupportActionsDeps } from "@admin-worker/handlers/list-support-actions";
import type { SupportRequestContext } from "@admin-worker/handlers/record-support-action";
import type { Env } from "@admin-worker/env";
import type {
  StoredSupportActionRecord,
  SupportPageQueryParams,
  SupportResult,
  SupportPagedResult,
  SupportCursorPosition,
} from "@saas/db/support";

function createFakeEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: {} as unknown as D1Database,
  };
}

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const ORG_PUBLIC = `org_${ORG_UUID.replace(/-/g, "")}`;

function makeRecord(id: string, occurredAt: string): StoredSupportActionRecord {
  return {
    id,
    actorId: "usr_agent",
    actorType: "user",
    targetOrgId: ORG_UUID,
    action: "view",
    reason: "investigating",
    requestId: "req_x",
    metadata: {},
    occurredAt: new Date(occurredAt),
    createdAt: new Date(occurredAt),
  };
}

function createDeps(
  page: SupportPagedResult<StoredSupportActionRecord>,
  captureParams: SupportPageQueryParams[] = [],
  events: unknown[] = [],
): ListSupportActionsDeps {
  return {
    supportRepo: {
      async listSupportActions(
        _orgId: string,
        params: SupportPageQueryParams,
      ): Promise<SupportResult<SupportPagedResult<StoredSupportActionRecord>>> {
        captureParams.push(params);
        return { ok: true, value: page };
      },
    },
    eventsRepo: {
      async appendEventWithAudit(args: unknown) {
        events.push(args);
        return { ok: true, value: { eventId: "evt", auditId: "aud" } } as never;
      },
    },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    generateId: () => "00000000-0000-4000-8000-000000000001",
  };
}

function ctx(overrides: Partial<SupportRequestContext> = {}): SupportRequestContext {
  return {
    actor: { subjectId: "usr_agent", subjectType: "user" },
    supportRoleClaim: "support_admin",
    systemOverride: false,
    ...overrides,
  };
}

describe("admin-worker: list-support-actions", () => {
  it("denies an unauthorized caller and audits the denial", async () => {
    const events: unknown[] = [];
    const deps = createDeps({ items: [], nextCursor: null }, [], events);
    const res = await handleListSupportActions(
      createFakeEnv(),
      "req_1",
      ctx({ actor: null, supportRoleClaim: null }),
      ORG_PUBLIC,
      new URL(`http://admin/v1/internal/support/organizations/${ORG_PUBLIC}/actions`),
      deps,
    );
    expect(res.status).toBe(403);
    expect(events).toHaveLength(1);
  });

  it("returns 404 for a malformed org id", async () => {
    const deps = createDeps({ items: [], nextCursor: null });
    const res = await handleListSupportActions(
      createFakeEnv(),
      "req_2",
      ctx(),
      "not-an-org-id",
      undefined,
      deps,
    );
    expect(res.status).toBe(404);
  });

  it("lists support actions for an authorized caller", async () => {
    const page: SupportPagedResult<StoredSupportActionRecord> = {
      items: [makeRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2026-01-01T00:00:00.000Z")],
      nextCursor: null,
    };
    const deps = createDeps(page);
    const res = await handleListSupportActions(
      createFakeEnv(),
      "req_3",
      ctx(),
      ORG_PUBLIC,
      new URL(`http://admin/v1/internal/support/organizations/${ORG_PUBLIC}/actions`),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { supportActions: Array<{ id: string }> };
      meta: { cursor: string | null };
    };
    expect(body.data.supportActions).toHaveLength(1);
    expect(body.data.supportActions[0]!.id).toMatch(/^sa_/);
    expect(body.meta.cursor).toBeNull();
  });

  it("emits a forward cursor when more results exist", async () => {
    const nextCursor: SupportCursorPosition = { occurredAt: "2026-01-01T00:00:00.000Z", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const page: SupportPagedResult<StoredSupportActionRecord> = {
      items: [makeRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "2026-01-01T00:00:00.000Z")],
      nextCursor,
    };
    const captured: SupportPageQueryParams[] = [];
    const deps = createDeps(page, captured);
    const res = await handleListSupportActions(
      createFakeEnv(),
      "req_4",
      ctx(),
      ORG_PUBLIC,
      new URL(`http://admin/v1/internal/support/organizations/${ORG_PUBLIC}/actions?limit=1`),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { cursor: string | null } };
    expect(body.meta.cursor).not.toBeNull();
    expect(captured[0]!.limit).toBe(1);
  });
});
