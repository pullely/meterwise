"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { pickAccountBillingOrg } from "@/components/billing/account-org";
import { useSession } from "@/lib/session";
import { readLastOrgSlug, clearLastOrgSlug, defaultOrgDestination } from "@/lib/last-org";
import { SOLO_MODE } from "@/lib/solo-mode";
import { useApiQuery, qk, usePrefetch } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";

export default function OrgsPage() {
  const { client } = useSession();
  const { toast } = useToast();
  const router = useRouter();
  const prefetch = usePrefetch();
  const orgs = useApiQuery(qk.orgs(), () =>
    wrap(async () => (await client.organizations.list()).organizations),
  );

  // Solo profile: there is no org chooser — the personal workspace is invisible.
  // Auto-resolve it and forward to its dashboard. Off the profile this is inert.
  React.useEffect(() => {
    if (!SOLO_MODE || !orgs.data || orgs.data.length === 0) return;
    const home = pickAccountBillingOrg(orgs.data)!;
    router.replace(defaultOrgDestination(home.slug));
  }, [orgs.data, router]);
  // Multi-org is gated on the account's billing parent (its earliest-created
  // org — same choice the membership-worker MO2 gate makes). The paywall's
  // "Upgrade plan" CTA starts a Business checkout for that org.
  const billingParent = React.useMemo(
    () => pickAccountBillingOrg(orgs.data ?? []),
    [orgs.data],
  );
  const onUpgrade = React.useCallback(async () => {
    if (!billingParent) return;
    const r = await wrap(() => client.billing.createCheckout(billingParent.id, { planCode: "business" }));
    if (!r.ok) {
      toast({ kind: "error", title: "Could not start checkout", description: r.error.message });
      return;
    }
    window.location.assign(r.data.checkoutUrl);
  }, [billingParent, client, toast]);

  // The org list is authoritative: if the remembered org isn't in it anymore,
  // forget it so the default landing doesn't point at an inaccessible org.
  React.useEffect(() => {
    const last = readLastOrgSlug();
    if (orgs.data && last && !orgs.data.some((o) => o.slug === last)) {
      clearLastOrgSlug();
    }
  }, [orgs.data]);

  // Solo: the org chooser is never shown — the personal workspace is invisible
  // and the effect above forwards to it. Render a neutral placeholder (no org
  // wording, no "create" CTA) while that resolves, matching /orgs/new. Off the
  // profile this is dead and the full chooser below renders unchanged.
  if (SOLO_MODE) {
    return (
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20 mt-2" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-3 w-44" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
          <p className="text-sm text-muted-foreground">
            Tenant root. Pick an org or create a new one.
          </p>
        </div>
        <Button asChild>
          <Link href="/orgs/new">
            <Plus className="h-4 w-4 mr-1.5" />
            New organization
          </Link>
        </Button>
      </header>

      {(orgs.data ?? []).some((o) => o.status === "suspended") && (
        <Card className="border-warning/40 bg-warning/5">
          <CardHeader>
            <CardTitle className="text-base">Some organizations are suspended</CardTitle>
            <CardDescription>
              One or more organizations are frozen because your account plan no longer includes
              multiple organizations. Upgrade to restore access to them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void onUpgrade()}>Upgrade plan</Button>
          </CardContent>
        </Card>
      )}

      {orgs.loading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-20 mt-2" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-3 w-44" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : orgs.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">Failed to load organizations</CardTitle>
            <CardDescription>{orgs.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !orgs.data || orgs.data.length === 0 ? (
        // Transient: the shell's OnboardingGate redirects zero-org accounts to
        // /onboarding; this renders only for the moment before it fires.
        <EmptyState
          icon={Building2}
          title="No organizations yet"
          description="Create your first organization to start provisioning projects and environments."
          primaryAction={{ label: "Create your organization", href: "/onboarding" }}
        />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {orgs.data.map((o) => (
            <Link
              key={o.id}
              href={`/orgs/${o.slug}/projects`}
              className="group"
              onMouseEnter={() =>
                prefetch(qk.projects(o.id), () =>
                  wrap(async () => (await client.projects.list(o.id)).projects),
                )
              }
            >
              <Card className="h-full transition-shadow group-hover:shadow-md group-hover:border-primary/40">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <div className="h-9 w-9 rounded-md bg-gradient-to-br from-primary/40 to-primary/10 grid place-items-center text-sm font-semibold">
                      {o.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <CardTitle className="text-base truncate">{o.name}</CardTitle>
                      <CardDescription className="text-xs">{o.slug}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="text-xs text-muted-foreground">
                    Created {new Date(o.createdAt).toLocaleDateString()}
                  </div>
                  {o.status === "suspended" ? (
                    <Badge variant="destructive">Suspended</Badge>
                  ) : null}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
