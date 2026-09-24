"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateOrgFlow } from "@/components/orgs/create-org-flow";
import { pickAccountBillingOrg } from "@/components/billing/account-org";
import { useSession } from "@/lib/session";
import { useRequireAuth } from "@/lib/use-async";
import { useApiQuery, qk } from "@/lib/query";
import { wrap, type ApiErrorBody } from "@/lib/api";
import { defaultOrgDestination, readLastOrgSlug } from "@/lib/last-org";
import { CONSOLE_TITLE } from "@/lib/app-config";
import { SOLO_MODE } from "@/lib/solo-mode";
import { personalWorkspaceName, personalWorkspaceSlug } from "@/lib/personal-workspace";

/**
 * Mandatory first-run onboarding (Supabase/Vercel-style): a focused, full-screen
 * surface — no app shell — where a freshly signed-up user names their parent
 * organization and picks a billing plan before anything else. The console has
 * no org-less working view, so this page is the only destination for an
 * authenticated user with zero organizations (the app shell's `OnboardingGate`
 * funnels here); once an org exists this page forwards to it instead.
 *
 * Under the Solo profile the user IS the tenant, so there is nothing to ask:
 * the page provisions the one personal workspace itself and forwards. That path
 * only runs when the identity-worker's login-time `ensurePersonalOrg` didn't
 * land (it is best-effort by design), which is precisely the case this page has
 * always been documented to catch.
 */
export default function OnboardingPage() {
  const ready = useRequireAuth();
  const router = useRouter();
  const { client, setToken } = useSession();
  const orgs = useApiQuery(
    qk.orgs(),
    () => wrap(async () => (await client.organizations.list()).organizations),
    { enabled: ready },
  );

  // Already onboarded — forward to the remembered org if it's still accessible,
  // else the account's billing-parent org. Covers deep links to /onboarding and
  // the post-create transition before the router leaves this page.
  const onboarded = (orgs.data?.length ?? 0) > 0;
  React.useEffect(() => {
    if (!orgs.data || orgs.data.length === 0) return;
    const last = readLastOrgSlug();
    const slug = orgs.data.some((o) => o.slug === last)
      ? last
      : pickAccountBillingOrg(orgs.data)!.slug;
    router.replace(defaultOrgDestination(slug));
  }, [orgs.data, router]);

  const selfHeal = useSoloSelfHeal(SOLO_MODE && orgs.data?.length === 0);

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
      <header className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 md:px-8">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/40 text-sm font-bold text-primary-foreground">
            S
          </div>
          <span className="text-sm font-semibold tracking-tight">{CONSOLE_TITLE}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setToken(null);
            router.replace("/login");
          }}
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </Button>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 pb-16 pt-8 md:px-8">
        {!ready || orgs.loading || onboarded ? (
          <OnboardingSkeleton />
        ) : orgs.error ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">Failed to load your account</CardTitle>
              <CardDescription>{orgs.error.message}</CardDescription>
            </CardHeader>
          </Card>
        ) : SOLO_MODE ? (
          selfHeal.error ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-destructive">Couldn&apos;t finish setting up</CardTitle>
                <CardDescription>{selfHeal.error.message}</CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <OnboardingSkeleton />
          )
        ) : (
          <CreateOrgFlow mode="parent" billingParent={null} variant="onboarding" />
        )}
      </main>
    </div>
  );
}

/**
 * Solo profile: create the account's one personal workspace, once, and refresh
 * the org list so the forward effect above takes over. A 409 means a concurrent
 * login (or a retried identity-side provision) already created it — the
 * deterministic slug guarantees it is the SAME workspace, so that is success.
 *
 * Inert (and zero requests) off the profile, or once an org exists.
 */
function useSoloSelfHeal(active: boolean): { error: ApiErrorBody | null } {
  const { client } = useSession();
  const qc = useQueryClient();
  const [error, setError] = React.useState<ApiErrorBody | null>(null);
  // One attempt per mount: the org-list refetch below is what ends this state,
  // so a retry loop would only stack duplicate creates behind the same slug.
  const attempted = React.useRef(false);

  React.useEffect(() => {
    if (!active || attempted.current) return;
    attempted.current = true;

    void (async () => {
      const me = await wrap(async () => (await client.auth.getProfile()).user);
      if (!me.ok) {
        setError(me.error);
        return;
      }
      const created = await wrap(() =>
        client.organizations.create({
          name: personalWorkspaceName(me.data),
          slug: personalWorkspaceSlug(me.data.id),
        }),
      );
      if (!created.ok && created.error.code !== "conflict") {
        setError(created.error);
        return;
      }
      void qc.invalidateQueries({ queryKey: qk.orgs() });
    })();
  }, [active, client, qc]);

  return { error };
}

function OnboardingSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
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
