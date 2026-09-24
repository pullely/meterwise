// `meterwise notifications preferences [--org=ORG_ID]`
// `meterwise notifications preferences set --category=CAT --enabled=true|false [--org=ORG_ID]`
//
// CLI leg of the PX3 notification-preferences surface (parity with the
// console settings page and a pure SDK consumer of
// `client.notifications.getPreferences` / `updatePreferences`).
//
// Subject scope: the api-edge facade pins `subjectKind`/`subjectId` to the
// bearer's actor, so these commands read/update the CALLER's own per-org
// email preferences. The `subjectId` sent on `set` is resolved from
// `client.auth.getProfile()` (the facade would override a forged one anyway).
//
// Semantics mirror the worker's opt-out model: a missing row or category
// means "deliver"; only explicit `false` suppresses a category.

import type {
  NotificationCategory,
  NotificationCategoryPreferences,
} from "@saas/sdk";
import type { CommandContext, CommandResult } from "../router.js";
import { formatOutput } from "../output/index.js";
import { UsageError } from "../errors.js";
import { resolveOrgId } from "./helpers.js";

const CATEGORIES: NotificationCategory[] = [
  "invitation",
  "billing",
  "security",
  "support",
  "product",
];

function effective(categories: NotificationCategoryPreferences | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const c of CATEGORIES) out[c] = categories?.[c] !== false;
  return out;
}

export async function notificationPreferencesGetCommand(
  ctx: CommandContext,
): Promise<CommandResult> {
  const orgId = await resolveOrgId(ctx, true);
  const client = await ctx.sdk();
  const { preferences } = await client.notifications.getPreferences({ orgId });
  const row = preferences.find((p) => p.channel === "email");
  const state = effective(row?.categories);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: { orgId, channel: "email", categories: state } }));
    return { exitCode: 0 };
  }
  ctx.stdout(
    formatOutput({
      mode: "human",
      title: `Email notification preferences (org ${orgId})`,
      columns: ["category", "enabled"],
      rows: CATEGORIES.map((c) => ({ category: c, enabled: String(state[c]) })),
    }),
  );
  return { exitCode: 0 };
}

export async function notificationPreferencesSetCommand(
  ctx: CommandContext,
): Promise<CommandResult> {
  const categoryFlag = ctx.flags["category"];
  const enabledFlag = ctx.flags["enabled"];
  if (typeof categoryFlag !== "string" || !CATEGORIES.includes(categoryFlag as NotificationCategory)) {
    throw new UsageError(`--category must be one of: ${CATEGORIES.join(", ")}`);
  }
  if (enabledFlag !== "true" && enabledFlag !== "false") {
    throw new UsageError(`--enabled must be "true" or "false"`);
  }
  const category = categoryFlag as NotificationCategory;
  const enabled = enabledFlag === "true";

  const orgId = await resolveOrgId(ctx, true);
  const client = await ctx.sdk();

  const [{ preferences }, { user }] = await Promise.all([
    client.notifications.getPreferences({ orgId }),
    client.auth.getProfile(),
  ]);
  const row = preferences.find((p) => p.channel === "email");
  const current = effective(row?.categories);

  const categories: NotificationCategoryPreferences = {};
  for (const c of CATEGORIES) categories[c] = c === category ? enabled : (current[c] as boolean);

  const { preference } = await client.notifications.updatePreferences({
    orgId,
    subjectKind: "user",
    subjectId: user.id,
    channel: "email",
    categories,
  });

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: { preference } }));
    return { exitCode: 0 };
  }
  const state = effective(preference.categories);
  ctx.stdout(
    formatOutput({
      mode: "human",
      title: `Updated: ${category} → ${enabled ? "enabled" : "disabled"}`,
      columns: ["category", "enabled"],
      rows: CATEGORIES.map((c) => ({ category: c, enabled: String(state[c]) })),
    }),
  );
  return { exitCode: 0 };
}
