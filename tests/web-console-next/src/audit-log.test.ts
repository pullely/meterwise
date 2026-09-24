import {
  appendAuditPage,
  auditEntriesToNdjson,
  buildAuditQuery,
  EMPTY_AUDIT_FILTERS,
  EMPTY_AUDIT_LOG,
  formatAuditActor,
  formatAuditTimestamp,
  hasActiveAuditFilters,
  hasMoreAudit,
  type AuditFilterFormValues,
  type AuditLogState,
} from "@web-console-next/components/audit/audit-log";
import type { PublicAuditEntry } from "@saas/contracts/events";

function entry(over: Partial<PublicAuditEntry> = {}): PublicAuditEntry {
  return {
    id: "ae_1",
    eventId: "evt_1",
    orgId: "org_1",
    projectId: null,
    environmentId: null,
    actorType: "user",
    actorId: "usr_abcdef0123456789",
    eventType: "member.role_changed",
    source: "membership-worker",
    category: "membership",
    description: "Role changed",
    subject: { kind: "member", id: "mem_1", name: null },
    occurredAt: "2026-01-16T10:00:00.000Z",
    requestId: "req_1",
    correlationId: null,
    payload: {},
    ...over,
  };
}

function values(over: Partial<AuditFilterFormValues> = {}): AuditFilterFormValues {
  return { ...EMPTY_AUDIT_FILTERS, ...over };
}

describe("buildAuditQuery", () => {
  it("yields a bare by:org query when no filters are set", () => {
    expect(buildAuditQuery(EMPTY_AUDIT_FILTERS)).toEqual({ by: "org" });
  });

  it("includes only non-empty, trimmed fields", () => {
    const q = buildAuditQuery(
      values({ actorId: "  usr_a  ", actorType: "user", from: "2026-01-01T00:00:00.000Z" }),
    );
    expect(q).toEqual({
      by: "org",
      actorId: "usr_a",
      actorType: "user",
      from: "2026-01-01T00:00:00.000Z",
    });
  });

  it("threads a cursor through for Load-more", () => {
    const q = buildAuditQuery(values({ category: "membership" }), "cur_2");
    expect(q).toEqual({ by: "org", category: "membership", cursor: "cur_2" });
  });

  it("treats whitespace-only fields as unset", () => {
    expect(buildAuditQuery(values({ actorId: "   " }))).toEqual({ by: "org" });
  });

  it("forwards every supported filter field", () => {
    const q = buildAuditQuery(
      values({
        category: "membership",
        actorId: "usr_a",
        actorType: "service_principal",
        subjectKind: "project",
        subjectId: "prj_1",
        eventType: "project.created",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-01T00:00:00.000Z",
      }),
    );
    expect(q).toEqual({
      by: "org",
      category: "membership",
      actorId: "usr_a",
      actorType: "service_principal",
      subjectKind: "project",
      subjectId: "prj_1",
      eventType: "project.created",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
    });
  });
});

describe("hasActiveAuditFilters", () => {
  it("is false for an all-blank form", () => {
    expect(hasActiveAuditFilters(EMPTY_AUDIT_FILTERS)).toBe(false);
    expect(hasActiveAuditFilters(values({ actorId: "  " }))).toBe(false);
  });

  it("is true when any field has content", () => {
    expect(hasActiveAuditFilters(values({ eventType: "x" }))).toBe(true);
  });
});

describe("formatAuditTimestamp", () => {
  it("returns the fallback for null / malformed values", () => {
    expect(formatAuditTimestamp(null)).toBe("—");
    expect(formatAuditTimestamp(undefined, "n/a")).toBe("n/a");
    expect(formatAuditTimestamp("not-a-date")).toBe("—");
  });

  it("formats a valid ISO timestamp without throwing", () => {
    const out = formatAuditTimestamp("2026-01-16T10:00:00.000Z");
    expect(out).not.toBe("—");
    expect(typeof out).toBe("string");
  });
});

describe("formatAuditActor", () => {
  it("renders type:id and truncates long ids", () => {
    expect(formatAuditActor(entry(), 6)).toBe("user:usr_ab");
  });

  it("keeps short ids intact", () => {
    expect(formatAuditActor({ actorType: "system", actorId: "sys" })).toBe("system:sys");
  });
});

describe("appendAuditPage", () => {
  it("replaces the list on reset", () => {
    const prev: AuditLogState = { entries: [entry({ id: "old" })], cursor: "c1" };
    const next = appendAuditPage(prev, { entries: [entry({ id: "ae_1" })], cursor: "c2" }, true);
    expect(next.entries.map((e) => e.id)).toEqual(["ae_1"]);
    expect(next.cursor).toBe("c2");
  });

  it("appends on Load-more and dedupes by id", () => {
    const prev: AuditLogState = { entries: [entry({ id: "ae_1" })], cursor: "c1" };
    const next = appendAuditPage(prev, {
      entries: [entry({ id: "ae_1" }), entry({ id: "ae_2" })],
      cursor: null,
    });
    expect(next.entries.map((e) => e.id)).toEqual(["ae_1", "ae_2"]);
    expect(next.cursor).toBeNull();
  });

  it("starts from EMPTY_AUDIT_LOG", () => {
    const next = appendAuditPage(EMPTY_AUDIT_LOG, { entries: [entry()], cursor: "c1" });
    expect(next.entries).toHaveLength(1);
  });
});

describe("hasMoreAudit", () => {
  it("reflects cursor presence", () => {
    expect(hasMoreAudit({ entries: [], cursor: "c1" })).toBe(true);
    expect(hasMoreAudit({ entries: [], cursor: null })).toBe(false);
  });
});

describe("auditEntriesToNdjson", () => {
  it("emits one JSON document per line with a trailing newline", () => {
    const out = auditEntriesToNdjson([entry({ id: "ae_1" }), entry({ id: "ae_2" })]);
    const lines = out.split("\n");
    // Two docs + trailing empty segment from the final newline.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0]!).id).toBe("ae_1");
    expect(JSON.parse(lines[1]!).id).toBe("ae_2");
  });

  it("returns an empty string for no entries", () => {
    expect(auditEntriesToNdjson([])).toBe("");
  });
});
