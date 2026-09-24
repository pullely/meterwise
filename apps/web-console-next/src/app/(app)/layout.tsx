"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { BottomTabs } from "@/components/shell/bottom-tabs";
import { LastOrgRecorder } from "@/components/shell/last-org-recorder";
import { Skeleton } from "@/components/ui/skeleton";
import { useRequireAuth } from "@/lib/use-async";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";

/**
 * App shell. The frame (sidebar + topbar rails) paints immediately so there's
 * no full-screen blank flash; the data-dependent shell content and page
 * children mount only once the session token has hydrated (`ready`), which
 * avoids firing requests with no token. `useRequireAuth` still redirects to
 * /login when there is genuinely no token (Task 0130 / PERF1).
 *
 * On mobile the desktop sidebar collapses (it's `hidden md:flex`); navigation
 * is provided by the topbar hamburger drawer and the bottom tab bar, so the
 * main column reserves bottom space for the tab bar + home-indicator inset.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const ready = useRequireAuth();
  return (
    <div className="flex min-h-screen bg-background">
      {ready ? (
        <Sidebar />
      ) : (
        <aside
          className="sticky top-0 hidden h-dvh w-60 shrink-0 self-start border-r bg-card/40 md:flex"
          aria-hidden
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {ready ? (
          <Topbar />
        ) : (
          <header
            className="sticky top-0 z-30 h-12 border-b bg-background/80 backdrop-blur-md pt-safe"
            aria-hidden
          />
        )}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-[calc(env(safe-area-inset-bottom)+4.5rem)] pt-6 md:px-8 md:pb-6">
          {ready ? children : <ShellSkeleton />}
        </main>
        {ready && <BottomTabs />}
      </div>
      {ready && <LastOrgRecorder />}
      {ready && <OnboardingGate />}
    </div>
  );
}

/**
 * Invisible guard: the console has no working view without an organization, so
 * an authenticated user with zero orgs is sent to the mandatory `/onboarding`
 * flow (create the parent org + pick a plan) from anywhere in the shell. Backed
 * by the shared `orgs` query the shell already fetches, so this adds no extra
 * request; on fetch errors it stays put rather than guessing.
 */
function OnboardingGate() {
  const router = useRouter();
  const { client } = useSession();
  const orgs = useApiQuery(qk.orgs(), () =>
    wrap(async () => (await client.organizations.list()).organizations),
  );
  React.useEffect(() => {
    if (orgs.data && orgs.data.length === 0) router.replace("/onboarding");
  }, [orgs.data, router]);
  return null;
}

function ShellSkeleton() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    </div>
  );
}
