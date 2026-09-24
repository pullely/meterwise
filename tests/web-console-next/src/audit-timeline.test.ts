import {
  AUDIT_CATEGORY_OPTIONS,
  buildAuditFilterChips,
  categoryAccent,
  EMPTY_AUDIT_FILTERS,
  formatRelativeTime,
  groupAuditEntriesByDay,
  presetFromIso,
} from "@web-console-next/components/audit/audit-log";
import type { PublicAuditEntry } from "@saas/contracts/events";

const NOW = new Date("2026-06-11T12:00:00.000Z").getTime();

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
    occurredAt: "2026-06-11T10:00:00.000Z",
    requestId: "req_1",
    correlationId: null,
    payload: {},
    ...over,
  };
}

describe("formatRelativeTime", () => {
  it("scales from seconds to days", () => {
    expect(formatRelativeTime("2026-06-11T11:59:30.000Z", NOW)).toBe("just now");
    expect(formatRelativeTime("2026-06-11T11:55:00.000Z", NOW)).toBe("5m ago");
    expect(formatRelativeTime("2026-06-11T09:00:00.000Z", NOW)).toBe("3h ago");
    expect(formatRelativeTime("2026-06-09T12:00:00.000Z", NOW)).toBe("2d ago");
  });

  it("falls back to a short date beyond 7 days", () => {
    const out = formatRelativeTime("2026-05-01T12:00:00.000Z", NOW);
    expect(out).not.toMatch(/ago$/);
    expect(out).toContain("2026");
  });

  it("tolerates null and malformed values", () => {
    expect(formatRelativeTime(null, NOW)).toBe("—");
    expect(formatRelativeTime("not-a-date", NOW)).toBe("—");
  });
});

describe("groupAuditEntriesByDay", () => {
  // The helper groups by *local* calendar day, so build timestamps from
  // local-time Date constructors to keep assertions timezone-stable.
  const localIso = (day: number, hour: number) => new Date(2026, 5, day, hour).toISOString();
  const LOCAL_NOW = new Date(2026, 5, 11, 12).getTime();

  it("labels today/yesterday and preserves input order", () => {
    const groups = groupAuditEntriesByDay(
      [
        entry({ id: "a", occurredAt: localIso(11, 10) }),
        entry({ id: "b", occurredAt: localIso(11, 8) }),
        entry({ id: "c", occurredAt: localIso(10, 22) }),
        entry({ id: "d", occurredAt: localIso(1, 8) }),
      ],
      LOCAL_NOW,
    );
    expect(groups.map((g) => g.entries.map((e) => e.id))).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(groups[0]!.label).toBe("Today");
    expect(groups[1]!.label).toBe("Yesterday");
    expect(groups[2]!.label).toContain("2026");
  });

  it("collects malformed timestamps into an Unknown date group", () => {
    const groups = groupAuditEntriesByDay([entry({ id: "x", occurredAt: "garbage" })], LOCAL_NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Unknown date");
  });
});

describe("presetFromIso", () => {
  it("resolves relative presets against now and leaves any/custom unset", () => {
    expect(presetFromIso("1h", NOW)).toBe("2026-06-11T11:00:00.000Z");
    expect(presetFromIso("24h", NOW)).toBe("2026-06-10T12:00:00.000Z");
    expect(presetFromIso("7d", NOW)).toBe("2026-06-04T12:00:00.000Z");
    expect(presetFromIso("any", NOW)).toBeUndefined();
    expect(presetFromIso("custom", NOW)).toBeUndefined();
  });
});

describe("categoryAccent", () => {
  it("gives every curated category a non-fallback accent", () => {
    for (const c of AUDIT_CATEGORY_OPTIONS) {
      const accent = categoryAccent(c);
      expect(accent.icon).toBeTruthy();
    }
  });

  it("falls back to the neutral accent for unknown categories", () => {
    expect(categoryAccent("definitely-not-a-category")).toEqual({ tone: "slate", icon: "ScrollText" });
  });
});

describe("buildAuditFilterChips", () => {
  it("emits one labelled chip per active filter, none when empty", () => {
    expect(buildAuditFilterChips(EMPTY_AUDIT_FILTERS)).toEqual([]);
    const chips = buildAuditFilterChips({
      ...EMPTY_AUDIT_FILTERS,
      category: "billing",
      eventType: "invoice.created",
    });
    expect(chips.map((c) => c.key).sort()).toEqual(["category", "eventType"]);
    expect(chips.find((c) => c.key === "category")!.label).toBe("category: billing");
  });
});
