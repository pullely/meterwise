/**
 * Pure navigation model for the sidebar and the mobile nav drawer (Task 0127 /
 * U11). Dependency-free (no React, no icons) so the section/link composition is
 * unit-testable and shared by both `sidebar.tsx` (desktop) and `mobile-nav.tsx`
 * (the Sheet drawer on small screens). Icon resolution happens in the renderer.
 */

import { SOLO_MODE } from "../../lib/solo-mode";

export interface NavLink {
  href: string;
  label: string;
  /** lucide icon name, resolved by the renderer. */
  icon: string;
  /** When true the link opens a nested sidebar panel (renderer shows a ›). */
  subPanel?: boolean;
}

export interface NavSection {
  /** stable id for keys/tests. */
  id: string;
  label: string;
  links: NavLink[];
}

export interface NavScope {
  orgSlug?: string | null;
  projectSlug?: string | null;
}

/**
 * Build the sidebar sections for the current URL scope. Org and project
 * sections only appear when their slug is present, matching the URL-driven
 * scope invariant (no local navigation state).
 *
 * Under the M0/Solo profile (`soloMode`) the org reads as the user's "Account":
 * projects and usage/quota are suppressed (hidden at the API edge too), the
 * section is relabelled, and project scope never appears. Defaults to the build
 * flag, so callers are unchanged; tests pass it explicitly for both profiles.
 */
export function buildNavSections(scope: NavScope, soloMode: boolean = SOLO_MODE): NavSection[] {
  const sections: NavSection[] = [];
  const orgSlug = scope.orgSlug ?? null;
  const projectSlug = scope.projectSlug ?? null;
  const orgBase = orgSlug ? `/orgs/${orgSlug}` : null;
  const projectBase = orgSlug && projectSlug ? `/orgs/${orgSlug}/projects/${projectSlug}` : null;

  // The Workspace/Organizations section is intentionally omitted: the org
  // switcher at the top of the sidebar is the home for org selection (and links
  // to the full list), so a separate "Organizations" nav row would be redundant.
  //
  // Account (Profile / Security activity) is likewise not a nav section — the
  // signed-in identity lives in the account chip at the bottom of the sidebar.

  if (orgBase) {
    // The primary sidebar is product-focused: the day-to-day surfaces an
    // operator works in. Organization administration (members, billing, API
    // keys, webhooks, config, audit, identity) lives behind a single Settings
    // entry, which opens the dedicated `/settings` surface with its own
    // secondary navigation (see `settings-nav.ts`).
    sections.push({
      id: "org",
      label: soloMode ? "Account" : orgSlug ? `Org · ${orgSlug}` : "Organization",
      links: soloMode
        ? [
            // Solo: projects & usage/quota are platform plumbing the B2C user
            // never sees; their surfaces collapse to the Settings (Account) panel.
            { href: `${orgBase}/settings`, label: "Settings", icon: "Settings", subPanel: true },
          ]
        : [
            { href: `${orgBase}/projects`, label: "Projects", icon: "FolderKanban" },
            { href: `${orgBase}/usage`, label: "Usage & quota", icon: "Gauge" },
            // Opens the dedicated settings panel — flagged so the renderer shows a ›.
            { href: `${orgBase}/settings`, label: "Settings", icon: "Settings", subPanel: true },
          ],
    });
  }

  // Project scope is suppressed entirely under Solo (no projects exist).
  if (projectBase && !soloMode) {
    sections.push({
      id: "project",
      label: projectSlug ? `Project · ${projectSlug}` : "Project",
      links: [
        { href: `${projectBase}/environments`, label: "Environments", icon: "Boxes" },
        { href: `${projectBase}/git`, label: "Git", icon: "GitBranch" },
        { href: `${projectBase}/config`, label: "Config", icon: "SlidersHorizontal" },
      ],
    });
  }

  return sections;
}

/**
 * Resolve the active link for a pathname: the longest matching `href` prefix
 * wins, so `/orgs/x/projects/y/environments` highlights Environments, not
 * Projects. `/orgs` (exact) only highlights when the path is exactly `/orgs`.
 */
export function isLinkActive(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  if (href === "/orgs") return pathname === "/orgs";
  if (href === "/account") return pathname === "/account";
  return pathname === href || pathname.startsWith(`${href}/`);
}
