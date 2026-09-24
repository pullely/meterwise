import type {
  NotificationCategory,
  NotificationCategoryPreferences,
  NotificationPreference,
} from "@saas/contracts/notifications";

/**
 * Pure model for the notification-preferences page. Dependency-free so the
 * default/merge semantics are unit-testable (settings-nav.ts convention).
 *
 * Semantics mirror the worker: a missing preference row — or a missing/null
 * category entry — means "deliver" (opt-out model). Only an explicit `false`
 * suppresses a category.
 */

export const PREFERENCE_CATEGORIES: Array<{
  key: NotificationCategory;
  label: string;
  description: string;
}> = [
  { key: "invitation", label: "Invitations", description: "Membership invites and acceptances." },
  { key: "billing", label: "Billing", description: "Receipts, plan changes, and payment issues." },
  {
    key: "security",
    label: "Security",
    description: "Sign-in codes and account alerts. Critical security email may still be delivered.",
  },
  { key: "support", label: "Support", description: "Replies to your support requests." },
  { key: "product", label: "Product", description: "Feature announcements and product updates." },
];

/** Resolve the effective on/off state per category from the stored rows. */
export function effectiveCategories(
  preferences: NotificationPreference[] | null | undefined,
): Record<NotificationCategory, boolean> {
  const row = preferences?.find((p) => p.channel === "email");
  const result = {} as Record<NotificationCategory, boolean>;
  for (const { key } of PREFERENCE_CATEGORIES) {
    const v = row?.categories?.[key];
    result[key] = v !== false; // null/undefined/true → deliver
  }
  return result;
}

/** Build the full categories payload for an update, flipping one category. */
export function buildUpdatedCategories(
  current: Record<NotificationCategory, boolean>,
  category: NotificationCategory,
  enabled: boolean,
): NotificationCategoryPreferences {
  const next: NotificationCategoryPreferences = {};
  for (const { key } of PREFERENCE_CATEGORIES) {
    next[key] = key === category ? enabled : current[key];
  }
  return next;
}
