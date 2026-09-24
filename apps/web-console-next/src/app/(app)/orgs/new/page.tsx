"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { pickAccountBillingOrg } from "@/components/billing/account-org";
import { CreateOrgFlow } from "@/components/orgs/create-org-flow";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { SOLO_MODE } from "@/lib/solo-mode";

/**
 * Guided create-organization flow for ADDITIONAL (child) organizations. The
 * account's first (parent) organization is always created through the
 * full-screen `/onboarding` flow, so an account with zero orgs is forwarded
 * there; the page resolves the org list before mounting the flow to decide.
 */
export default function NewOrgPage() {
  const router = useRouter();
  const { client } = useSession();
  const orgs = useApiQuery(qk.orgs(), () =>
    wrap(async () => (await client.organizations.list()).organizations),
  );

  const needsOnboarding = orgs.data?.length === 0;
  React.useEffect(() => {
    // Solo: the user is the tenant and cannot create a second org — bounce home.
    // (The API edge also 404s POST /v1/organizations; this is the UI guard.)
    if (SOLO_MODE) {
      router.replace("/");
      return;
    }
    if (needsOnboarding) router.replace("/onboarding");
  }, [needsOnboarding, router]);

  if (SOLO_MODE || orgs.loading || needsOnboarding) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <Skeleton className="h-4 w-28" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-72 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div className="flex gap-10 pt-2">
          <div className="hidden w-56 shrink-0 space-y-8 md:block">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
          <Skeleton className="h-72 flex-1 rounded-lg" />
        </div>
      </div>
    );
  }

  if (orgs.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Failed to load your account</CardTitle>
          <CardDescription>{orgs.error.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return <CreateOrgFlow mode="child" billingParent={pickAccountBillingOrg(orgs.data ?? [])} />;
}
