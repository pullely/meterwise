import { handleRecordSupportAction } from "@admin-worker/handlers/record-support-action";
import type { RecordSupportActionDeps, SupportRequestContext } from "@admin-worker/handlers/record-support-action";
import type { Env } from "@admin-worker/env";
import type {
  StoredSupportActionRecord,
  RecordSupportActionInput,
  SupportResult,
} from "@saas/db/support";

function createFakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: {} as unknown as D1Database,
    ...overrides,
  };
}

interface Captured {
  records: RecordSupportActionInput[];
  events: Array<{ event: unknown; audit: unknown }>;
}

function createDeps(
  capture: Captured,
  opts: { recordFails?: boolean } = {},
): RecordSupportActionDeps {
  return {
    supportRepo: {
      async recordSupportAction(input: RecordSupportActionInput): Promise<SupportResult<StoredSupportActionRecord>> {
        capture.records.push(input);
        if (opts.recordFails) {
          return { ok: false, error: { kind: "internal", message: "boom" } };
        }
        const stored: StoredSupportActionRecord = {
          id: input.id,
          actorId: input.actorId,
          actorType: input.actorType,
          targetOrgId: input.targetOrgId,
          action: input.action,
          reason: input.reason,
          requestId: input.requestId,
          metadata: input.metadata ?? {},
          occurredAt: input.occurredAt,
          createdAt: input.occurredAt,
        };
        return { ok: true, value: stored };
      },
    },
    eventsRepo: {
      async appendEventWithAudit(args: { event: unknown; audit: unknown }) {
        capture.events.push(args);
        return { ok: true, value: { eventId: "evt_1", auditId: "aud_1" } } as never;
      },
    },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    generateId: () => "00000000-0000-4000-8000-000000000001",
  };
}

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const ORG_PUBLIC = `org_${ORG_UUID.replace(/-/g, "")}`;

function ctx(overrides: Partial<SupportRequestContext> = {}): SupportRequestContext {
  return {
    actor: { subjectId: "usr_agent", subjectType: "user" },
    supportRoleClaim: "support_agent",
    systemOverride: false,
    ...overrides,
  };
}

describe("admin-worker: record-support-action", () => {
  describe("deny-by-default authorization", () => {
    it("denies when no actor is present and audits the denial", async () => {
      const cap: Captured = { records: [], events: [] };
      const res = await handleRecordSupportAction(
        createFakeEnv(),
        "req_1",
        ctx({ actor: null, supportRoleClaim: null }),
        { targetOrgId: ORG_PUBLIC, action: "view", reason: "investigating" },
        createDeps(cap),
      );
      expect(res.status).toBe(403);
      expect(cap.records).toHaveLength(0);
      // The denial must be audited.
      expect(cap.events).toHaveLength(1);
    });

    it("denies an unrecognized support role", async () => {
      const cap: Captured = { records: [], events: [] };
      const res = await handleRecordSupportAction(
        createFakeEnv(),
        "req_2",
        ctx({ supportRoleClaim: "billing_admin" }),
        { targetOrgId: ORG_PUBLIC, action: "view", reason: "x" },
        createDeps(cap),
      );
      expect(res.status).toBe(403);
      expect(cap.records).toHaveLength(0);
      expect(cap.events).toHaveLength(1);
    });

    it("denies a system override from a non-system actor", async () => {
      const cap: Captured = { records: [], events: [] };
      const res = await handleRecordSupportAction(
        createFakeEnv(),
        "req_3",
        ctx({ supportRoleClaim: null, systemOverride: true, actor: { subjectId: "usr_x", subjectType: "user" } }),
        { targetOrgId: ORG_PUBLIC, action: "view", reason: "x" },
        createDeps(cap),
      );
      expect(res.status).toBe(403);
      expect(cap.records).toHaveLength(0);
    });
  });

  describe("authorized path", () => {
    it("records an action and appends the audit event atomically (sequential test path)", async () => {
      const cap: Captured = { records: [], events: [] };
      const res = await handleRecordSupportAction(
        createFakeEnv(),
        "req_4",
        ctx(),
        { targetOrgId: ORG_PUBLIC, action: "reset_password", reason: "user request" },
        createDeps(cap),
      );
      expect(res.status).toBe(201);
      expect(cap.records).toHaveLength(1);
      expect(cap.events).toHaveLength(1);
      const body = (await res.json()) as { data: { supportAction: { action: string; id: string } } };
      expect(body.data.supportAction.action).toBe("reset_password");
      expect(body.data.supportAction.id).toMatch(/^sa_/);
    });

    it("allows a system override from a system actor", async () => {
      const cap: Captured = { records: [], events: [] };
      const res = await handleRecordSupportAction(
        createFakeEnv(),
        "req_5",
        ctx({ supportRoleClaim: null, systemOverride: true, actor: { subjectId: "svc_break_glass", subjectType: "system" } }),
        { targetOrgId: ORG_PUBLIC, action: "force_unlock", reason: "incident" },
        createDeps(cap),
      );
      expect(res.status).toBe(201);
      expect(cap.records).toHaveLength(1);
    });

    it("returns 500 when the record write fails", async () => {
      const cap: Captured = { records: [], events: [] };
      const res = await handleRecordSupportAction(
        createFakeEnv(),
        "req_6",
        ctx(),
        { targetOrgId: ORG_PUBLIC, action: "view", reason: "x" },
        createDeps(cap, { recordFails: true }),
      );
      expect(res.status).toBe(500);
      expect(cap.events).toHaveLength(0);
    });
  });

  describe("validation", () => {
    it("rejects a missing reason with 422", async () => {
      const cap: Captured = { records: [], events: [] };
      const res = await handleRecordSupportAction(
        createFakeEnv(),
        "req_7",
        ctx(),
        { targetOrgId: ORG_PUBLIC, action: "view" },
        createDeps(cap),
      );
      expect(res.status).toBe(422);
    });
  });
});
