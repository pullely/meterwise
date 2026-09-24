import {
  handleLookupOrganizationForSupport,
  handleLookupUserForSupport,
} from "@admin-worker/handlers/lookup-support";
import type { LookupSupportDeps } from "@admin-worker/handlers/lookup-support";
import type { SupportRequestContext } from "@admin-worker/handlers/record-support-action";
import type { Env } from "@admin-worker/env";
import type {
  SupportOrganizationProjection,
  SupportUserProjection,
  SupportResult,
} from "@saas/db/support";

function createFakeEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: {} as unknown as D1Database,
  };
}

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const ORG_PUBLIC = `org_${ORG_UUID.replace(/-/g, "")}`;
const USER_UUID = "22222222-2222-4222-8222-222222222222";
const USER_PUBLIC = `usr_${USER_UUID.replace(/-/g, "")}`;

function orgProjection(): SupportOrganizationProjection {
  return {
    orgId: ORG_UUID,
    name: "Acme",
    slug: "acme",
    status: "active",
    memberCount: 7,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function userProjection(): SupportUserProjection {
  return {
    userId: USER_UUID,
    email: "user@example.com",
    displayName: "Test User",
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function createDeps(
  opts: {
    org?: SupportResult<SupportOrganizationProjection>;
    user?: SupportResult<SupportUserProjection>;
    events?: unknown[];
  } = {},
): LookupSupportDeps {
  return {
    supportRepo: {
      async lookupOrganizationForSupport(): Promise<SupportResult<SupportOrganizationProjection>> {
        return opts.org ?? { ok: true, value: orgProjection() };
      },
      async lookupUserForSupport(): Promise<SupportResult<SupportUserProjection>> {
        return opts.user ?? { ok: true, value: userProjection() };
      },
    },
    eventsRepo: {
      async appendEventWithAudit(args: unknown) {
        opts.events?.push(args);
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
    supportRoleClaim: "support_agent",
    systemOverride: false,
    ...overrides,
  };
}

describe("admin-worker: lookup-organization (diagnostic projection)", () => {
  it("denies an unauthorized caller and audits the denial", async () => {
    const events: unknown[] = [];
    const res = await handleLookupOrganizationForSupport(
      createFakeEnv(),
      "req_1",
      ctx({ actor: null, supportRoleClaim: null }),
      ORG_PUBLIC,
      createDeps({ events }),
    );
    expect(res.status).toBe(403);
    expect(events).toHaveLength(1);
  });

  it("returns a narrow projection for an authorized caller (no secrets)", async () => {
    const res = await handleLookupOrganizationForSupport(
      createFakeEnv(),
      "req_2",
      ctx(),
      ORG_PUBLIC,
      createDeps(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { organization: Record<string, unknown> } };
    const org = body.data.organization;
    expect(org.orgId).toBe(ORG_PUBLIC);
    expect(org.name).toBe("Acme");
    expect(org.memberCount).toBe(7);
    // Projection must NOT carry secrets/connection strings/internal uuids.
    expect(Object.keys(org).sort()).toEqual(
      ["createdAt", "memberCount", "name", "orgId", "slug", "status"].sort(),
    );
  });

  it("returns 404 for a malformed org id", async () => {
    const res = await handleLookupOrganizationForSupport(
      createFakeEnv(),
      "req_3",
      ctx(),
      "bad-id",
      createDeps(),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when the org is not found", async () => {
    const res = await handleLookupOrganizationForSupport(
      createFakeEnv(),
      "req_4",
      ctx(),
      ORG_PUBLIC,
      createDeps({ org: { ok: false, error: { kind: "not_found" } } }),
    );
    expect(res.status).toBe(404);
  });
});

describe("admin-worker: lookup-user (diagnostic projection)", () => {
  it("denies an unauthorized caller", async () => {
    const res = await handleLookupUserForSupport(
      createFakeEnv(),
      "req_5",
      ctx({ supportRoleClaim: "nope" }),
      USER_PUBLIC,
      ORG_PUBLIC,
      createDeps(),
    );
    expect(res.status).toBe(403);
  });

  it("returns a narrow user projection for an authorized caller", async () => {
    const res = await handleLookupUserForSupport(
      createFakeEnv(),
      "req_6",
      ctx(),
      USER_PUBLIC,
      ORG_PUBLIC,
      createDeps(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { user: Record<string, unknown> } };
    const user = body.data.user;
    expect(user.userId).toBe(USER_PUBLIC);
    expect(user.email).toBe("user@example.com");
    expect(Object.keys(user).sort()).toEqual(
      ["createdAt", "displayName", "email", "status", "userId"].sort(),
    );
  });

  it("allows a system-override lookup with no target org and attributes audit to the user", async () => {
    const res = await handleLookupUserForSupport(
      createFakeEnv(),
      "req_7",
      ctx({ supportRoleClaim: null, systemOverride: true, actor: { subjectId: "svc", subjectType: "system" } }),
      USER_PUBLIC,
      null,
      createDeps(),
    );
    expect(res.status).toBe(200);
  });

  it("returns 404 for a malformed user id", async () => {
    const res = await handleLookupUserForSupport(
      createFakeEnv(),
      "req_8",
      ctx(),
      "bad-id",
      ORG_PUBLIC,
      createDeps(),
    );
    expect(res.status).toBe(404);
  });
});
