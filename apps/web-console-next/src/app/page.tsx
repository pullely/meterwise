"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { readStoredToken } from "@/lib/session";
import { readLastOrgSlug, defaultOrgDestination } from "@/lib/last-org";

/**
 * App entry. Sends the operator to their last-used org (if remembered) so
 * returning visits land in a working org scope; otherwise to /onboarding, which
 * forwards to an existing org or creates the first one — or to /login when
 * there's no session. localStorage is client-only, so this resolves on the
 * client and replaces history (no extra entry).
 */
export default function HomePage() {
  const router = useRouter();
  React.useEffect(() => {
    const dest = readStoredToken() ? defaultOrgDestination(readLastOrgSlug()) : "/login";
    router.replace(dest);
  }, [router]);

  return (
    <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">
      Loading…
    </div>
  );
}
