import {
  createEventsRepository,
} from "@saas/db/events";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(options?: {
  rows?: Record<string, unknown>[];
  error?: unknown;
  rowCount?: number;
  callResponses?: Array<{ rows?: Record<string, unknown>[]; rowCount?: number; error?: unknown }>;
}): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  let callIndex = 0;
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });

      if (options?.callResponses && callIndex < options.callResponses.length) {
        const response = options.callResponses[callIndex]!;
        callIndex++;
        if (response.error) throw response.error;
        const rows = (response.rows ?? []) as unknown as T[];
        return { rows, rowCount: response.rowCount ?? rows.length };
      }

      if (options?.error) throw options.error;
      const rows = (options?.rows ?? []) as unknown as T[];
      return { rows, rowCount: options?.rowCount ?? rows.length };
    },
  };
  return { executor, queries };
}

const NOW = new Date("2026-01-15T10:00:00Z");

const SAMPLE_EVENT_ROW = {
  id: "evt-001",
  type: "organization.created",
  version: 1,
  source: "membership-worker",
  occurred_at: NOW.toISOString(),
  actor_type: "user",
  actor_id: "usr-001",
  actor_session_id: "ses-001",
  actor_ip: "203.0.113.10",
  org_id: "org-001",
  project_id: null,
  environment_id: null,
  subject_kind: "organization",
  subject_id: "org-001",
  subject_name: "Acme Corp",
  request_id: "req-001",
  correlation_id: "cor-001",
  causation_id: null,
  idempotency_key: "idem-001",
  payload: JSON.stringify({ name: "Acme Corp" }),
  redact_paths: JSON.stringify([]),
  created_at: NOW.toISOString(),
};

const SAMPLE_AUDIT_ROW_DATA = {
  id: "aud-001",
  event_id: "evt-001",
  org_id: "org-001",
  project_id: null,
  environment_id: null,
  actor_type: "user",
  actor_id: "usr-001",
  event_type: "organization.created",
  event_version: 1,
  source: "membership-worker",
  subject_kind: "organization",
  subject_id: "org-001",
  subject_name: "Acme Corp",
  category: "general",
  description: "Organization created",
  occurred_at: NOW.toISOString(),
  request_id: "req-001",
  correlation_id: "cor-001",
  payload: JSON.stringify({ name: "Acme Corp" }),
  redact_paths: JSON.stringify(["$.payload.secret"]),
  created_at: NOW.toISOString(),
};

const SAMPLE_AUDIT_ROW = { ...SAMPLE_AUDIT_ROW_DATA };

const SAMPLE_EVENT_WITH_AUDIT_ROW = {
  _event: SAMPLE_EVENT_ROW,
  _audit: SAMPLE_AUDIT_ROW_DATA,
};

describe("events repository: appendEvent", () => {
  it("inserts an event and returns the mapped entity", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_EVENT_ROW] });
    const repo = createEventsRepository(executor);

    const result = await repo.appendEvent({
      id: "evt-001",
      type: "organization.created",
      version: 1,
      source: "membership-worker",
      occurredAt: NOW,
      actorType: "user",
      actorId: "usr-001",
      actorSessionId: "ses-001",
      actorIp: "203.0.113.10",
      orgId: "org-001",
      subjectKind: "organization",
      subjectId: "org-001",
      subjectName: "Acme Corp",
      requestId: "req-001",
      correlationId: "cor-001",
      idempotencyKey: "idem-001",
      payload: { name: "Acme Corp" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("evt-001");
      expect(result.value.type).toBe("organization.created");
      expect(result.value.orgId).toBe("org-001");
      expect(result.value.actorType).toBe("user");
      expect(result.value.payload).toEqual({ name: "Acme Corp" });
    }
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("INSERT INTO events_event_log");
    expect(queries[0]!.text).toContain("ON CONFLICT (id) DO NOTHING");
  });

  it("uses parameterized SQL", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_EVENT_ROW] });
    const repo = createEventsRepository(executor);

    await repo.appendEvent({
      id: "evt-001",
      type: "organization.created",
      version: 1,
      source: "membership-worker",
      occurredAt: NOW,
      actorType: "user",
      actorId: "usr-001",
      orgId: "org-001",
      subjectKind: "organization",
      subjectId: "org-001",
      requestId: "req-001",
      payload: { name: "Acme Corp" },
    });

    // Params array should contain the values, not interpolated into SQL
    expect(queries[0]!.params.length).toBeGreaterThan(0);
    expect(queries[0]!.text).toContain("$1");
    expect(queries[0]!.text).not.toContain("evt-001");
  });

  it("returns conflict on duplicate event ID (no rows returned)", async () => {
    const { executor } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    const result = await repo.appendEvent({
      id: "evt-001",
      type: "organization.created",
      version: 1,
      source: "membership-worker",
      occurredAt: NOW,
      actorType: "user",
      actorId: "usr-001",
      orgId: "org-001",
      subjectKind: "organization",
      subjectId: "org-001",
      requestId: "req-001",
      payload: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("conflict");
    }
  });

  it("returns conflict on a SQLite unique-constraint failure", async () => {
    const { executor } = createFakeExecutor({ error: new Error("D1_ERROR: UNIQUE constraint failed") });
    const repo = createEventsRepository(executor);

    const result = await repo.appendEvent({
      id: "evt-001",
      type: "organization.created",
      version: 1,
      source: "membership-worker",
      occurredAt: NOW,
      actorType: "user",
      actorId: "usr-001",
      orgId: "org-001",
      subjectKind: "organization",
      subjectId: "org-001",
      requestId: "req-001",
      payload: {},
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("serializes JSON payload and redact paths", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_EVENT_ROW] });
    const repo = createEventsRepository(executor);

    await repo.appendEvent({
      id: "evt-001",
      type: "test.event",
      version: 1,
      source: "test",
      occurredAt: NOW,
      actorType: "system",
      actorId: "sys",
      orgId: "org-001",
      subjectKind: "test",
      subjectId: "t-1",
      requestId: "req-001",
      payload: { key: "value" },
      redactPaths: ["$.payload.key"],
    });

    const params = queries[0]!.params;
    // payload should be JSON string
    expect(params[19]).toBe(JSON.stringify({ key: "value" }));
    // redactPaths should be JSON string
    expect(params[20]).toBe(JSON.stringify(["$.payload.key"]));
  });
});

describe("events repository: appendEventWithAudit", () => {
  it("inserts event and audit in one SQL statement", async () => {
    const { executor, queries } = createFakeExecutor({
      rows: [SAMPLE_EVENT_WITH_AUDIT_ROW],
    });
    const repo = createEventsRepository(executor);

    const result = await repo.appendEventWithAudit({
      event: {
        id: "evt-001",
        type: "organization.created",
        version: 1,
        source: "membership-worker",
        occurredAt: NOW,
        actorType: "user",
        actorId: "usr-001",
        actorSessionId: "ses-001",
        actorIp: "203.0.113.10",
        orgId: "org-001",
        subjectKind: "organization",
        subjectId: "org-001",
        subjectName: "Acme Corp",
        requestId: "req-001",
        correlationId: "cor-001",
        payload: { name: "Acme Corp" },
      },
      audit: {
        id: "aud-001",
        category: "general",
        description: "Organization created",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.event.id).toBe("evt-001");
      expect(result.value.audit.id).toBe("aud-001");
      expect(result.value.audit.eventId).toBe("evt-001");
    }
    // Only one SQL call (CTE)
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("WITH inserted_event AS");
    expect(queries[0]!.text).toContain("inserted_audit AS");
  });

  it("returns conflict when event already exists (no event row returned)", async () => {
    const { executor } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    const result = await repo.appendEventWithAudit({
      event: {
        id: "evt-001",
        type: "organization.created",
        version: 1,
        source: "membership-worker",
        occurredAt: NOW,
        actorType: "user",
        actorId: "usr-001",
        orgId: "org-001",
        subjectKind: "organization",
        subjectId: "org-001",
        requestId: "req-001",
        payload: {},
      },
      audit: { id: "aud-001" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });
});

describe("events repository: queryAuditByOrg", () => {
  it("queries audit entries by organization with cursor pagination", async () => {
    const rows = [
      { ...SAMPLE_AUDIT_ROW, id: "aud-001" },
      { ...SAMPLE_AUDIT_ROW, id: "aud-002" },
    ];
    const { executor, queries } = createFakeExecutor({ rows });
    const repo = createEventsRepository(executor);

    const result = await repo.queryAuditByOrg("org-001", { limit: 10, cursor: null });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(2);
      expect(result.value.nextCursor).toBeNull();
    }
    expect(queries[0]!.text).toContain("WHERE org_id IN ($1, $2)");
    expect(queries[0]!.text).toContain("ORDER BY occurred_at DESC, id DESC");
    expect(queries[0]!.params[0]).toBe("org-001");
    // Legacy org_ format for backward compatibility
    expect(queries[0]!.params[1]).toBe("org_org001");
    // limit + 1 to detect next page
    expect(queries[0]!.params[2]).toBe(11);
  });

  it("returns nextCursor when more items exist", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      ...SAMPLE_AUDIT_ROW,
      id: `aud-${String(i).padStart(3, "0")}`,
      occurred_at: new Date(NOW.getTime() - i * 1000).toISOString(),
    }));
    const { executor } = createFakeExecutor({ rows });
    const repo = createEventsRepository(executor);

    const result = await repo.queryAuditByOrg("org-001", { limit: 2, cursor: null });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(2);
      expect(result.value.nextCursor).not.toBeNull();
      expect(result.value.nextCursor!.id).toBe("aud-001");
    }
  });

  it("applies cursor condition when provided", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    await repo.queryAuditByOrg("org-001", {
      limit: 10,
      cursor: { occurredAt: "2026-01-15T09:00:00Z", id: "aud-005" },
    });

    expect(queries[0]!.text).toContain("(occurred_at, id) < ($4, $5)");
    expect(queries[0]!.params[3]).toBe("2026-01-15T09:00:00Z");
    expect(queries[0]!.params[4]).toBe("aud-005");
  });

  it("filters by category when provided", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    await repo.queryAuditByOrg("org-001", { limit: 10, cursor: null }, "membership");

    expect(queries[0]!.text).toContain("category = $3");
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("org_org001");
    expect(queries[0]!.params[2]).toBe("membership");
    expect(queries[0]!.params[3]).toBe(11);
  });

  it("applies both category and cursor conditions", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    await repo.queryAuditByOrg("org-001", {
      limit: 5,
      cursor: { occurredAt: "2026-01-15T09:00:00Z", id: "aud-010" },
    }, "projects");

    expect(queries[0]!.text).toContain("category = $3");
    expect(queries[0]!.text).toContain("(occurred_at, id) < ($5, $6)");
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("org_org001");
    expect(queries[0]!.params[2]).toBe("projects");
    expect(queries[0]!.params[3]).toBe(6);
    expect(queries[0]!.params[4]).toBe("2026-01-15T09:00:00Z");
    expect(queries[0]!.params[5]).toBe("aud-010");
  });

  it("does not add category clause when category is undefined", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    await repo.queryAuditByOrg("org-001", { limit: 10, cursor: null }, undefined);

    expect(queries[0]!.text).not.toContain("category");
  });

  it("returns safe internal error on query failure", async () => {
    const { executor } = createFakeExecutor({ rows: [], error: new Error("db crash") });
    const repo = createEventsRepository(executor);

    const result = await repo.queryAuditByOrg("org-001", { limit: 10, cursor: null }, "membership");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("internal");
    }
  });

  it("filters by actor, subject, and event type with parameterized equality", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    await repo.queryAuditByOrg("org-001", { limit: 10, cursor: null }, undefined, {
      actorId: "usr-123",
      actorType: "user",
      subjectKind: "project",
      subjectId: "prj-9",
      eventType: "member.role_changed",
    });

    const text = queries[0]!.text;
    expect(text).toContain("actor_id = $3");
    expect(text).toContain("actor_type = $4");
    expect(text).toContain("subject_kind = $5");
    expect(text).toContain("subject_id = $6");
    expect(text).toContain("event_type = $7");
    expect(text).not.toContain("usr-123");
    expect(text).not.toContain("member.role_changed");
    expect(queries[0]!.params.slice(2, 7)).toEqual([
      "usr-123",
      "user",
      "project",
      "prj-9",
      "member.role_changed",
    ]);
    expect(queries[0]!.params[7]).toBe(11);
  });

  it("applies an inclusive occurred_at time window for from/to", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    await repo.queryAuditByOrg("org-001", { limit: 10, cursor: null }, undefined, {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
    });

    const text = queries[0]!.text;
    expect(text).toContain("occurred_at >= $3");
    expect(text).toContain("occurred_at <= $4");
    expect(queries[0]!.params[2]).toBe("2026-01-01T00:00:00.000Z");
    expect(queries[0]!.params[3]).toBe("2026-02-01T00:00:00.000Z");
  });

  it("composes category + filters + cursor without altering ORDER BY", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    await repo.queryAuditByOrg(
      "org-001",
      { limit: 5, cursor: { occurredAt: "2026-01-15T09:00:00Z", id: "aud-010" } },
      "membership",
      { actorType: "service_principal", from: "2026-01-01T00:00:00.000Z" },
    );

    const text = queries[0]!.text;
    expect(text).toContain("WHERE org_id IN ($1, $2)");
    expect(text).toContain("category = $3");
    expect(text).toContain("actor_type = $4");
    expect(text).toContain("occurred_at >= $5");
    expect(text).toContain("ORDER BY occurred_at DESC, id DESC");
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[2]).toBe("membership");
    expect(queries[0]!.params[3]).toBe("service_principal");
    expect(queries[0]!.params[4]).toBe("2026-01-01T00:00:00.000Z");
    expect(queries[0]!.params[5]).toBe(6);
    expect(queries[0]!.params[6]).toBe("2026-01-15T09:00:00Z");
    expect(queries[0]!.params[7]).toBe("aud-010");
  });

  it("adds no filter clauses when filters is empty", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    await repo.queryAuditByOrg("org-001", { limit: 10, cursor: null }, undefined, {});

    const text = queries[0]!.text;
    expect(text).not.toContain("actor_id");
    expect(text).not.toContain("occurred_at >=");
    expect(queries[0]!.params[2]).toBe(11);
  });
});

describe("events repository: queryAuditByTarget", () => {
  it("queries by org + subject kind/id", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_AUDIT_ROW] });
    const repo = createEventsRepository(executor);

    const result = await repo.queryAuditByTarget("org-001", "organization", "org-001", { limit: 10, cursor: null });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.items[0]!.subjectKind).toBe("organization");
    }
    expect(queries[0]!.text).toContain("subject_kind = $2");
    expect(queries[0]!.text).toContain("subject_id = $3");
    expect(queries[0]!.params[1]).toBe("organization");
    expect(queries[0]!.params[2]).toBe("org-001");
  });

  it("applies cursor for target queries", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    await repo.queryAuditByTarget("org-001", "member", "mem-001", {
      limit: 5,
      cursor: { occurredAt: "2026-01-15T09:00:00Z", id: "aud-010" },
    });

    expect(queries[0]!.text).toContain("(occurred_at, id) < ($5, $6)");
    expect(queries[0]!.params[4]).toBe("2026-01-15T09:00:00Z");
    expect(queries[0]!.params[5]).toBe("aud-010");
  });
});

describe("events repository: JSON handling", () => {
  it("deserializes JSON string payload from database", async () => {
    const row = { ...SAMPLE_AUDIT_ROW, payload: '{"complex":{"nested":true}}' };
    const { executor } = createFakeExecutor({ rows: [row] });
    const repo = createEventsRepository(executor);

    const result = await repo.queryAuditByOrg("org-001", { limit: 10, cursor: null });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items[0]!.payload).toEqual({ complex: { nested: true } });
    }
  });

  it("deserializes object payload from database (pre-parsed by driver)", async () => {
    const row = { ...SAMPLE_AUDIT_ROW, payload: { already: "parsed" } };
    const { executor } = createFakeExecutor({ rows: [row] });
    const repo = createEventsRepository(executor);

    const result = await repo.queryAuditByOrg("org-001", { limit: 10, cursor: null });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items[0]!.payload).toEqual({ already: "parsed" });
    }
  });

  it("preserves redaction paths", async () => {
    const row = { ...SAMPLE_AUDIT_ROW, redact_paths: JSON.stringify(["$.payload.secret", "$.payload.token"]) };
    const { executor } = createFakeExecutor({ rows: [row] });
    const repo = createEventsRepository(executor);

    const result = await repo.queryAuditByOrg("org-001", { limit: 10, cursor: null });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items[0]!.redactPaths).toEqual(["$.payload.secret", "$.payload.token"]);
    }
  });

  it("queries both raw UUID and legacy org_ format for backward compatibility", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    await repo.queryAuditByOrg("a1b2c3d4-e5f6-7890-abcd-ef1234567890", { limit: 10, cursor: null });

    // Must use IN clause with both formats
    expect(queries[0]!.text).toContain("WHERE org_id IN ($1, $2)");
    expect(queries[0]!.params[0]).toBe("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    expect(queries[0]!.params[1]).toBe("org_a1b2c3d4e5f67890abcdef1234567890");
  });
});

describe("events repository: getEventById", () => {
  it("returns the mapped event when the row exists", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_EVENT_ROW] });
    const repo = createEventsRepository(executor);

    const result = await repo.getEventById("org-001", "evt-001");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
      expect(result.value!.id).toBe("evt-001");
      expect(result.value!.type).toBe("organization.created");
      // Full payload is rehydrated — this is what makes manual replay
      // resend the original body rather than data:{}.
      expect(result.value!.payload).toEqual({ name: "Acme Corp" });
    }
    // Parameterized, org-scoped lookup by id.
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("FROM events_event_log");
    expect(queries[0]!.params).toEqual(["org-001", "evt-001"]);
  });

  it("returns null when no row matches (absent, not an error)", async () => {
    const { executor } = createFakeExecutor({ rows: [] });
    const repo = createEventsRepository(executor);

    const result = await repo.getEventById("org-001", "evt-missing");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it("surfaces a safe error when the query throws", async () => {
    const { executor } = createFakeExecutor({ error: new Error("connection lost") });
    const repo = createEventsRepository(executor);

    const result = await repo.getEventById("org-001", "evt-001");

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "internal") {
      expect(result.error.message).toBe("Failed to get event by id");
    }
  });
});
