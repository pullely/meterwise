import type { ConfigScope } from "@saas/sdk";

/**
 * Pure helpers for the config surface (settings / flags / secrets).
 * Dependency-free so input parsing, display formatting, and cache-key scoping
 * are unit-testable, mirroring the `settings-nav.ts` convention.
 */

/**
 * Parse a setting/flag value typed into a single-line input.
 *
 * Settings values are JSON (`unknown`) on the contract. Operators type either
 * a bare string ("eu-west-1") or a JSON literal (true, 42, {"a":1}). Valid
 * JSON wins; anything else is stored as the raw string — deterministic and
 * round-trippable with `formatConfigValue`.
 */
export function parseConfigValueInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

/** Render a stored `unknown` value for display / edit prefill. */
export function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Stable cache-key discriminator for a config scope. Encodes the kind and
 * every id so org/project/environment surfaces never share cache entries.
 */
export function configScopeKey(scope: ConfigScope): string {
  switch (scope.kind) {
    case "organization":
      return `org:${scope.orgId}`;
    case "project":
      return `org:${scope.orgId}/proj:${scope.projectId}`;
    case "environment":
      return `org:${scope.orgId}/proj:${scope.projectId}/env:${scope.environmentId}`;
  }
}
