"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { AccountTabs } from "@/components/account/account-tabs";
import {
  appendSecurityPage,
  EMPTY_SECURITY_EVENTS,
  hasMoreSecurityEvents,
  toSecurityRow,
  type SecurityEventsState,
} from "@/components/security/security-events";

/**
 * Account security activity.
 *
 * Actor/account-scoped (NOT org-scoped): there is no `OrgScope`, no `orgId`,
 * and no org filters. The SDK call hits `/v1/auth/security-events` for the
 * authenticated actor. Cursor pagination mirrors the audit log — the opaque
 * `nextCursor` from `listPage` is passed back verbatim for "Load more".
 */
export default function AccountSecurityPage() {
  const { client } = useSession();

  const [state, setState] = React.useState<SecurityEventsState>(EMPTY_SECURITY_EVENTS);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);

  const loadFirstPage = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await wrap(() => client.securityEvents.listPage());
    if (res.ok) {
      setState(appendSecurityPage(EMPTY_SECURITY_EVENTS, res.data, /* reset */ true));
    } else {
      setError({ code: res.error.code, message: res.error.message });
      setState(EMPTY_SECURITY_EVENTS);
    }
    setLoading(false);
  }, [client]);

  React.useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = React.useCallback(async () => {
    if (state.cursor === null) return;
    const cursor = state.cursor;
    setLoadingMore(true);
    const res = await wrap(() => client.securityEvents.listPage({ cursor }));
    if (res.ok) {
      setState((prev) => appendSecurityPage(prev, res.data));
    } else {
      setError({ code: res.error.code, message: res.error.message });
    }
    setLoadingMore(false);
  }, [client, state.cursor]);

  const rows = state.events.map(toSecurityRow);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Account</h1>
        <p className="text-sm text-muted-foreground">Manage your profile and session.</p>
      </header>

      <AccountTabs active="security" />

      <header>
        <h2 className="text-base font-semibold tracking-tight">Security activity</h2>
        <p className="text-sm text-muted-foreground">
          Recent authentication and session events on your account, newest
          first. Sensitive material (codes, tokens, hashes) is never shown.
        </p>
      </header>

      {loading ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{error.code}</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No security activity"
          description="Sign-ins, session changes, and other account security events will surface here as they happen."
        />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Card key={r.id} className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {r.eventType}
                    </Badge>
                    <Badge variant={r.badge.variant} className="text-[10px]">
                      {r.badge.label}
                    </Badge>
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono mt-1">
                    {r.ip} · {r.userAgent}
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground whitespace-nowrap">
                  {r.occurredAtLabel}
                </div>
              </div>
            </Card>
          ))}

          {hasMoreSecurityEvents(state) ? (
            <div className="flex justify-center pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
