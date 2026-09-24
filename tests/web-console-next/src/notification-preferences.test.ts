import {
  PREFERENCE_CATEGORIES,
  effectiveCategories,
  buildUpdatedCategories,
} from "@web-console-next/components/notifications/preferences";
import type { NotificationPreference } from "@saas/contracts/notifications";

const row = (categories: NotificationPreference["categories"]): NotificationPreference => ({
  subjectKind: "user",
  subjectId: "usr_1",
  orgId: "org_1",
  channel: "email",
  categories,
  updatedAt: "2026-06-11T00:00:00Z",
});

describe("effectiveCategories", () => {
  it("defaults every category to deliver when no row exists", () => {
    const state = effectiveCategories(undefined);
    for (const { key } of PREFERENCE_CATEGORIES) expect(state[key]).toBe(true);
  });

  it("treats null/missing entries as deliver and only false as suppressed", () => {
    const state = effectiveCategories([row({ billing: false, product: null, support: true })]);
    expect(state.billing).toBe(false);
    expect(state.product).toBe(true);
    expect(state.support).toBe(true);
    expect(state.invitation).toBe(true);
  });

  it("ignores non-email channel rows", () => {
    const other = { ...row({ billing: false }), channel: "sms" as never };
    const state = effectiveCategories([other]);
    expect(state.billing).toBe(true);
  });
});

describe("buildUpdatedCategories", () => {
  it("flips only the requested category and keeps the rest explicit", () => {
    const current = effectiveCategories([row({ billing: false })]);
    const next = buildUpdatedCategories(current, "product", false);
    expect(next.product).toBe(false);
    expect(next.billing).toBe(false);
    expect(next.invitation).toBe(true);
    expect(next.security).toBe(true);
    expect(next.support).toBe(true);
  });
});
