/**
 * Pure helper: seed a branch → environment map for a newly linked repo.
 * Dependency-free so the suggestion logic is unit-testable.
 *
 * Heuristic (Vercel-style): map the repo's default branch to the most
 * production-looking environment — slug "prod"/"production" wins, else the
 * first active environment. No default branch or no environments → empty map.
 */
export interface EnvironmentLike {
  slug: string;
  status?: string;
}

const PRODUCTION_SLUGS = new Set(["prod", "production", "live"]);

export function suggestBranchEnvMap(
  defaultBranch: string | null,
  environments: EnvironmentLike[],
): Record<string, string> {
  if (!defaultBranch) return {};
  const active = environments.filter((e) => !e.status || e.status === "active");
  if (active.length === 0) return {};
  const production = active.find((e) => PRODUCTION_SLUGS.has(e.slug.toLowerCase()));
  const target = production ?? active[0]!;
  return { [defaultBranch]: target.slug };
}
