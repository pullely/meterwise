import type { Scope } from "@saas/db/config";

/**
 * Returns true when a stored row's scope fields exactly match
 * the requested route scope. This prevents same-org cross-project
 * or cross-environment aliases.
 */
export function scopeMatchesRequested(
  stored: { scopeKind: string; orgId: string; projectId: string | null; environmentId: string | null },
  requested: Scope,
): boolean {
  if (stored.scopeKind !== requested.kind) return false;
  if (stored.orgId !== requested.orgId) return false;

  switch (requested.kind) {
    case "organization":
      return stored.projectId === null && stored.environmentId === null;
    case "project":
      return stored.projectId === requested.projectId && stored.environmentId === null;
    case "environment":
      return stored.projectId === requested.projectId && stored.environmentId === requested.environmentId;
  }
}
