"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useOrgBySlug } from "@/lib/use-org";
import { readLastOrgSlug, clearLastOrgSlug } from "@/lib/last-org";
import { buildBreadcrumbs } from "./breadcrumbs";
import { AlertTriangle, ChevronRight } from "lucide-react";

/**
 * Shared wrapper for per-org pages: resolves slug → org, surfaces
 * loading and not-found states uniformly so each page can stay focused
 * on its resource.
 */
export function OrgScope({
  slug,
  children,
}: {
  slug: string;
  children: (org: { id: string; name: string; slug: string }) => React.ReactNode;
}) {
  const { org, loading, error } = useOrgBySlug(slug);

  // Self-heal the remembered-org hint: if this slug resolves to nothing (org
  // archived or access revoked), drop it so the default landing falls back to
  // the picker instead of looping back to a dead org.
  React.useEffect(() => {
    if (!loading && !error && !org && readLastOrgSlug() === slug) {
      clearLastOrgSlug();
    }
  }, [loading, error, org, slug]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid sm:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-3 w-40" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Failed to load organization
          </CardTitle>
          <CardDescription>{error.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!org) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Organization not found"
        description={`No org matches slug “${slug}”. It may have been archived or you no longer have access.`}
        primaryAction={{ label: "Back to organizations", href: "/orgs" }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <OrgBreadcrumbs orgSlug={org.slug} orgName={org.name} />
      {children(org)}
    </div>
  );
}

/**
 * Persistent wayfinding: a real breadcrumb `<nav>` derived from the URL (the
 * source of truth for scope), replacing the old `slug-chip + name` echo.
 */
function OrgBreadcrumbs({ orgSlug, orgName }: { orgSlug: string; orgName: string }) {
  const pathname = usePathname();
  const crumbs = buildBreadcrumbs({ orgSlug, orgName, pathname });

  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-sm">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1">
              {i > 0 && (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
              )}
              {crumb.href && !last ? (
                <Link
                  href={crumb.href}
                  className="truncate text-muted-foreground transition-colors hover:text-foreground"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className={last ? "truncate font-medium" : "truncate text-muted-foreground"}
                >
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
