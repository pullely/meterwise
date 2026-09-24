/**
 * Pure navigation model for the organization Settings surface.
 *
 * Dependency-free (no React, no icons) so the group/link composition is
 * unit-testable and shared by the settings layout's secondary nav rail (desktop)
 * and its horizontal pill bar (mobile). Icon resolution happens in the renderer.
 *
 * Settings is the dedicated "organization administration" surface: the primary
 * sidebar stays product-focused (Projects, Usage), while everything that
 * configures the org — identity, people, billing, and developer integrations —
 * lives here behind `/orgs/[slug]/settings/*`.
 */

import { SOLO_MODE } from "../../lib/solo-mode";

// Settings sub-paths suppressed under the M0/Solo profile (also 404'd at the API
// edge): collaboration (members, invitations), credentials (api-keys), and the
// developer integration surface (webhooks, integrations, audit). Kept: General,
// Notifications, Billing, and Config (feature flags).
const SOLO_SUPPRESSED_PATHS = [
  "/members",
  "/invitations",
  "/api-keys",
  "/webhooks",
  "/integrations",
  "/audit",
];

export interface SettingsNavLink {
  href: string;
  label: string;
  /** lucide icon name, resolved by the renderer. */
  icon: string;
  /** short helper copy shown under the label in the rail. */
  description: string;
  /**
   * When true the link is active only on an exact pathname match. Used for the
   * Settings index (General) so it doesn't stay highlighted on every child page.
   */
  exact?: boolean;
}

export interface SettingsNavGroup {
  /** stable id for keys/tests. */
  id: string;
  label: string;
  links: SettingsNavLink[];
}

/**
 * Build the grouped settings navigation for an org. Grouping mirrors how modern
 * consoles (Stripe, Vercel, Linear) split settings: who/what the org is, how
 * it pays, and the developer-facing integration surface.
 */
export function buildSettingsNav(orgSlug: string, soloMode: boolean = SOLO_MODE): SettingsNavGroup[] {
  const base = `/orgs/${orgSlug}/settings`;
  const groups: SettingsNavGroup[] = [
    {
      id: "organization",
      label: "Organization",
      links: [
        {
          href: base,
          label: "General",
          icon: "Building2",
          description: "Name, slug, and identifiers",
          exact: true,
        },
        {
          href: `${base}/members`,
          label: "Members",
          icon: "Users",
          description: "People with access",
        },
        {
          href: `${base}/invitations`,
          label: "Invitations",
          icon: "Mail",
          description: "Pending invites",
        },
        {
          href: `${base}/notifications`,
          label: "Notifications",
          icon: "Bell",
          description: "Your email preferences",
        },
      ],
    },
    {
      id: "billing",
      label: "Billing",
      links: [
        {
          href: `${base}/billing`,
          label: "Billing & plan",
          icon: "Receipt",
          description: "Plan, invoices, payment",
        },
      ],
    },
    {
      id: "developer",
      label: "Developer",
      links: [
        {
          href: `${base}/api-keys`,
          label: "API keys",
          icon: "KeyRound",
          description: "Programmatic access tokens",
        },
        {
          href: `${base}/webhooks`,
          label: "Webhooks",
          icon: "Webhook",
          description: "Signed event deliveries",
        },
        {
          href: `${base}/integrations`,
          label: "Integrations",
          icon: "Plug",
          description: "Connected providers (GitHub)",
        },
        {
          href: `${base}/config`,
          label: "Config",
          icon: "SlidersHorizontal",
          description: "Flags and configuration",
        },
        {
          href: `${base}/audit`,
          label: "Audit log",
          icon: "ScrollText",
          description: "Security and change history",
        },
      ],
    },
  ];

  if (!soloMode) return groups;

  // Solo: the user IS the tenant. Relabel the org group to "Account", drop the
  // suppressed links, and omit any group left empty (e.g. a Developer group that
  // now holds only Config). Off the profile this is never reached.
  return groups
    .map((g) => ({
      ...g,
      label: g.id === "organization" ? "Account" : g.label,
      links: g.links.filter(
        (l) => !SOLO_SUPPRESSED_PATHS.some((p) => l.href === `${base}${p}` || l.href.startsWith(`${base}${p}/`)),
      ),
    }))
    .filter((g) => g.links.length > 0);
}

/** Flatten the grouped nav into an ordered link list (used by the mobile bar). */
export function flattenSettingsNav(groups: SettingsNavGroup[]): SettingsNavLink[] {
  return groups.flatMap((g) => g.links);
}

/**
 * Resolve the active settings link for a pathname. The General (index) link
 * matches exactly; every other link matches when the path is the href or a
 * child of it (so `/settings/webhooks/ep_123` keeps Webhooks active).
 */
export function isSettingsLinkActive(link: SettingsNavLink, pathname: string | null): boolean {
  if (!pathname) return false;
  if (link.exact) return pathname === link.href;
  return pathname === link.href || pathname.startsWith(`${link.href}/`);
}
