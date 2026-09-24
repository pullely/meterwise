import {
  deliveryStatusBadge,
  formatDeliveryTimestamp,
  toDeliveryRow,
  appendDeliveryPage,
  hasMoreDeliveries,
  EMPTY_DELIVERY_HISTORY,
  type DeliveryHistoryState,
} from "@web-console-next/components/webhooks/delivery-history";
import type { PublicWebhookDeliveryAttempt } from "@saas/contracts";

function attempt(
  over: Partial<PublicWebhookDeliveryAttempt> = {},
): PublicWebhookDeliveryAttempt {
  return {
    id: "att_1",
    orgId: "org_1",
    endpointId: "ep_1",
    subscriptionId: "sub_1",
    eventId: "evt_1",
    eventType: "user.created",
    status: "success",
    attemptNumber: 1,
    httpStatusCode: 200,
    failureReason: null,
    idempotencyKey: null,
    nextRetryAt: null,
    completedAt: "2026-01-16T10:00:00.000Z",
    createdAt: "2026-01-16T09:59:59.000Z",
    updatedAt: "2026-01-16T10:00:00.000Z",
    ...over,
  };
}

describe("deliveryStatusBadge", () => {
  it("maps each known status to its variant + label", () => {
    expect(deliveryStatusBadge("success")).toEqual({
      variant: "success",
      label: "Success",
    });
    expect(deliveryStatusBadge("failed")).toEqual({
      variant: "destructive",
      label: "Failed",
    });
    expect(deliveryStatusBadge("retrying")).toEqual({
      variant: "warning",
      label: "Retrying",
    });
    expect(deliveryStatusBadge("pending")).toEqual({
      variant: "secondary",
      label: "Pending",
    });
  });

  it("falls back to a neutral outline badge for an unknown status", () => {
    const badge = deliveryStatusBadge("teleported" as never);
    expect(badge.variant).toBe("outline");
    expect(badge.label).toBe("teleported");
  });
});

describe("formatDeliveryTimestamp", () => {
  it("returns the fallback for null / undefined / empty", () => {
    expect(formatDeliveryTimestamp(null)).toBe("—");
    expect(formatDeliveryTimestamp(undefined)).toBe("—");
    expect(formatDeliveryTimestamp("")).toBe("—");
    expect(formatDeliveryTimestamp(null, "never")).toBe("never");
  });

  it("returns the fallback for an unparseable timestamp", () => {
    expect(formatDeliveryTimestamp("not-a-date")).toBe("—");
  });

  it("formats a valid ISO timestamp to a non-fallback string", () => {
    const out = formatDeliveryTimestamp("2026-01-16T10:00:00.000Z");
    expect(out).not.toBe("—");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("toDeliveryRow", () => {
  it("shapes a successful attempt", () => {
    const row = toDeliveryRow(attempt());
    expect(row.id).toBe("att_1");
    expect(row.eventType).toBe("user.created");
    expect(row.badge.variant).toBe("success");
    expect(row.attemptNumber).toBe(1);
    expect(row.httpStatus).toBe("200");
    expect(row.failureReason).toBeNull();
    expect(row.nextRetryAtLabel).toBeNull();
    expect(row.completedAtLabel).not.toBe("—");
  });

  it("renders an em-dash for a null HTTP status (never reached the wire)", () => {
    const row = toDeliveryRow(
      attempt({ httpStatusCode: null, status: "pending", completedAt: null }),
    );
    expect(row.httpStatus).toBe("—");
    expect(row.completedAtLabel).toBe("—");
  });

  it("surfaces the safe failure reason and next-retry timestamp on a retrying attempt", () => {
    const row = toDeliveryRow(
      attempt({
        status: "retrying",
        httpStatusCode: 503,
        completedAt: null,
        failureReason: "upstream 503",
        nextRetryAt: "2026-01-16T10:05:00.000Z",
      }),
    );
    expect(row.badge.variant).toBe("warning");
    expect(row.failureReason).toBe("upstream 503");
    expect(row.nextRetryAtLabel).not.toBeNull();
  });
});

describe("appendDeliveryPage", () => {
  it("replaces the list on reset and records the cursor", () => {
    const next = appendDeliveryPage(
      EMPTY_DELIVERY_HISTORY,
      { deliveryAttempts: [attempt({ id: "a" })], nextCursor: "CUR1" },
      true,
    );
    expect(next.attempts.map((a) => a.id)).toEqual(["a"]);
    expect(next.cursor).toBe("CUR1");
  });

  it("concatenates a subsequent page and advances the cursor", () => {
    const first: DeliveryHistoryState = {
      attempts: [attempt({ id: "a" })],
      cursor: "CUR1",
    };
    const next = appendDeliveryPage(first, {
      deliveryAttempts: [attempt({ id: "b" }), attempt({ id: "c" })],
      nextCursor: null,
    });
    expect(next.attempts.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(next.cursor).toBeNull();
  });

  it("is idempotent on id — a boundary attempt repeated across pages is not duplicated", () => {
    const first: DeliveryHistoryState = {
      attempts: [attempt({ id: "a" }), attempt({ id: "b" })],
      cursor: "CUR1",
    };
    const next = appendDeliveryPage(first, {
      deliveryAttempts: [attempt({ id: "b" }), attempt({ id: "c" })],
      nextCursor: "CUR2",
    });
    expect(next.attempts.map((a) => a.id)).toEqual(["a", "b", "c"]);
    expect(next.cursor).toBe("CUR2");
  });

  it("passes the opaque cursor back verbatim without mutation", () => {
    const opaque = "eyJjcmVhdGVkQXQiOiIyMDI2In0=";
    const next = appendDeliveryPage(
      EMPTY_DELIVERY_HISTORY,
      { deliveryAttempts: [], nextCursor: opaque },
      true,
    );
    expect(next.cursor).toBe(opaque);
  });
});

describe("hasMoreDeliveries", () => {
  it("is true only while a continuation cursor remains", () => {
    expect(hasMoreDeliveries({ attempts: [], cursor: "CUR1" })).toBe(true);
    expect(hasMoreDeliveries({ attempts: [], cursor: null })).toBe(false);
    expect(hasMoreDeliveries(EMPTY_DELIVERY_HISTORY)).toBe(false);
  });
});
