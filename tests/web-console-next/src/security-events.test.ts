import {
  securityOutcomeBadge,
  formatSecurityTimestamp,
  toSecurityRow,
  appendSecurityPage,
  hasMoreSecurityEvents,
  EMPTY_SECURITY_EVENTS,
  type SecurityEventsState,
} from "@web-console-next/components/security/security-events";
import type { PublicSecurityEvent } from "@saas/contracts/security-events";

function event(
  over: Partial<PublicSecurityEvent> = {},
): PublicSecurityEvent {
  return {
    id: "sec_1",
    eventType: "session.created",
    outcome: "success",
    occurredAt: "2026-01-16T10:00:00.000Z",
    requestId: "req_1",
    correlationId: null,
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    metadata: {},
    ...over,
  };
}

describe("securityOutcomeBadge", () => {
  it("maps each known outcome to its variant + label", () => {
    expect(securityOutcomeBadge("success")).toEqual({
      variant: "success",
      label: "Success",
    });
    expect(securityOutcomeBadge("failure")).toEqual({
      variant: "destructive",
      label: "Failure",
    });
  });

  it("falls back to a neutral outline badge for an unknown outcome", () => {
    const badge = securityOutcomeBadge("teleported" as never);
    expect(badge.variant).toBe("outline");
    expect(badge.label).toBe("teleported");
  });
});

describe("formatSecurityTimestamp", () => {
  it("returns the fallback for null / undefined / empty", () => {
    expect(formatSecurityTimestamp(null)).toBe("—");
    expect(formatSecurityTimestamp(undefined)).toBe("—");
    expect(formatSecurityTimestamp("")).toBe("—");
    expect(formatSecurityTimestamp(null, "never")).toBe("never");
  });

  it("returns the fallback for an unparseable timestamp", () => {
    expect(formatSecurityTimestamp("not-a-date")).toBe("—");
  });

  it("formats a valid ISO timestamp to a non-fallback string", () => {
    const out = formatSecurityTimestamp("2026-01-16T10:00:00.000Z");
    expect(out).not.toBe("—");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("toSecurityRow", () => {
  it("shapes a successful event", () => {
    const row = toSecurityRow(event());
    expect(row.id).toBe("sec_1");
    expect(row.eventType).toBe("session.created");
    expect(row.outcome).toBe("success");
    expect(row.badge.variant).toBe("success");
    expect(row.ip).toBe("203.0.113.7");
    expect(row.userAgent).toBe("Mozilla/5.0");
    expect(row.occurredAtLabel).not.toBe("—");
  });

  it("renders an em-dash for a null ip / user-agent", () => {
    const row = toSecurityRow(event({ ip: null, userAgent: null }));
    expect(row.ip).toBe("—");
    expect(row.userAgent).toBe("—");
  });

  it("surfaces a failure outcome with the destructive badge", () => {
    const row = toSecurityRow(
      event({ eventType: "login.challenge.failed", outcome: "failure" }),
    );
    expect(row.badge.variant).toBe("destructive");
    expect(row.badge.label).toBe("Failure");
  });
});

describe("appendSecurityPage", () => {
  it("replaces the list on reset and records the cursor", () => {
    const next = appendSecurityPage(
      EMPTY_SECURITY_EVENTS,
      { securityEvents: [event({ id: "a" })], nextCursor: "CUR1" },
      true,
    );
    expect(next.events.map((e) => e.id)).toEqual(["a"]);
    expect(next.cursor).toBe("CUR1");
  });

  it("concatenates a subsequent page and advances the cursor", () => {
    const first: SecurityEventsState = {
      events: [event({ id: "a" })],
      cursor: "CUR1",
    };
    const next = appendSecurityPage(first, {
      securityEvents: [event({ id: "b" }), event({ id: "c" })],
      nextCursor: null,
    });
    expect(next.events.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(next.cursor).toBeNull();
  });

  it("is idempotent on id — a boundary event repeated across pages is not duplicated", () => {
    const first: SecurityEventsState = {
      events: [event({ id: "a" }), event({ id: "b" })],
      cursor: "CUR1",
    };
    const next = appendSecurityPage(first, {
      securityEvents: [event({ id: "b" }), event({ id: "c" })],
      nextCursor: "CUR2",
    });
    expect(next.events.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(next.cursor).toBe("CUR2");
  });

  it("passes the opaque cursor back verbatim without mutation", () => {
    const opaque = "eyJjcm...2In0=";
    const next = appendSecurityPage(
      EMPTY_SECURITY_EVENTS,
      { securityEvents: [], nextCursor: opaque },
      true,
    );
    expect(next.cursor).toBe(opaque);
  });
});

describe("hasMoreSecurityEvents", () => {
  it("is true only while a continuation cursor remains", () => {
    expect(hasMoreSecurityEvents({ events: [], cursor: "CUR1" })).toBe(true);
    expect(hasMoreSecurityEvents({ events: [], cursor: null })).toBe(false);
    expect(hasMoreSecurityEvents(EMPTY_SECURITY_EVENTS)).toBe(false);
  });
});
