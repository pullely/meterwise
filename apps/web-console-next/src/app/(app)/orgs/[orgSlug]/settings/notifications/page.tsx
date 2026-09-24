"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { BellRing } from "lucide-react";
import type { NotificationCategory } from "@saas/contracts/notifications";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import {
  PREFERENCE_CATEGORIES,
  effectiveCategories,
  buildUpdatedCategories,
} from "@/components/notifications/preferences";

export default function NotificationsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  // The edge pins the subject to the session actor; we only scope by org.
  const prefs = useApiQuery(qk.notificationPrefs(orgId), () =>
    wrap(async () => (await client.notifications.getPreferences({ orgId })).preferences),
  );
  const profile = useApiQuery(qk.profile(), () =>
    wrap(async () => (await client.auth.getProfile()).user),
  );

  const stored = effectiveCategories(prefs.data);
  // Optimistic per-category overrides while an update is in flight.
  const [overrides, setOverrides] = React.useState<Partial<Record<NotificationCategory, boolean>>>(
    {},
  );
  const current = { ...stored, ...overrides };

  const toggle = async (category: NotificationCategory, enabled: boolean) => {
    if (!profile.data) return;
    setOverrides((o) => ({ ...o, [category]: enabled }));
    const r = await wrap(() =>
      client.notifications.updatePreferences({
        orgId,
        subjectKind: "user",
        subjectId: profile.data!.id,
        channel: "email",
        categories: buildUpdatedCategories(current, category, enabled),
      }),
    );
    if (!r.ok) {
      setOverrides((o) => {
        const next = { ...o };
        delete next[category];
        return next;
      });
      toast({ kind: "error", title: "Update failed", description: r.error.message });
      return;
    }
    prefs.reload();
  };

  return (
    <div className="space-y-5">
      <header>
        <div className="flex items-center gap-2">
          <BellRing className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Which categories of email you receive for this organization. Applies to your account
          only.
        </p>
      </header>

      {prefs.loading || profile.loading ? (
        <Card>
          <CardContent className="space-y-3 pt-6">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : prefs.error ? (
        <Card>
          <CardContent className="pt-6">
            <div className="text-sm font-medium text-destructive">Failed to load preferences</div>
            <div className="text-xs text-muted-foreground">{prefs.error.message}</div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y divide-border pt-2">
            {PREFERENCE_CATEGORIES.map((c) => (
              <div key={c.key} className="flex items-center justify-between gap-4 py-3.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium" id={`pref-${c.key}`}>
                    {c.label}
                  </div>
                  <div className="text-xs text-muted-foreground">{c.description}</div>
                </div>
                <Switch
                  checked={current[c.key]}
                  onCheckedChange={(on) => void toggle(c.key, on)}
                  aria-labelledby={`pref-${c.key}`}
                  disabled={!profile.data}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
