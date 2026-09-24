"use client";

import * as React from "react";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import type { PublicOrganization } from "@saas/contracts/membership";

/**
 * Resolves an organization slug to its full record.
 *
 * URL-driven scope (we never store the resolved id in localStorage). Backed by
 * the single shared `orgs` query, so OrgScope no longer fetches the full org
 * list on every per-org page navigation — after the first load it resolves the
 * slug synchronously from cache (Task 0130 / PERF1).
 */
export function useOrgBySlug(slug: string) {
  const { client } = useSession();
  const state = useApiQuery(qk.orgs(), () =>
    wrap(async () => (await client.organizations.list()).organizations),
  );
  const org: PublicOrganization | null = React.useMemo(() => {
    if (!state.data) return null;
    return state.data.find((o) => o.slug === slug) ?? null;
  }, [state.data, slug]);
  return { org, loading: state.loading, error: state.error, reload: state.reload };
}
