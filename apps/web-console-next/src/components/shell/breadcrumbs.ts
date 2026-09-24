/**
 * Pure breadcrumb model for org-scoped pages.
 *
 * Dependency-free (no React, no icons) so the path → trail derivation is
 * unit-testable, mirroring `settings-nav.ts`. The renderer lives in
 * `org-scope.tsx`. The URL is the source of truth for scope, so the trail is
 * derived from the pathname plus the already-resolved org — never from
 * client-side navigation state.
 */

export interface Crumb {
  label: string;
  /** Absent on the current (last) crumb — it is not a link. */
  href?: string;
}

/** Page labels for org-scoped leaf segments. */
const SEGMENT_LABELS: Record<string, string> = {
  projects: "Projects",
  environments: "Environments",
  usage: "Usage & quota",
  settings: "Settings",
  members: "Members",
  invitations: "Invitations",
  "api-keys": "API keys",
  webhooks: "Webhooks",
  billing: "Billing & plan",
  "change-plan": "Change plan",
  config: "Config",
  audit: "Audit log",
  notifications: "Notifications",
};

/**
 * Segments that carry a dynamic child (a slug/id) we should render as its own
 * crumb. Maps the parent segment to the href suffix that makes the dynamic
 * crumb navigable (e.g. a project crumb links to its environments list).
 */
const DYNAMIC_CHILD_HREF: Record<string, string> = {
  projects: "/environments",
};

/**
 * Build the breadcrumb trail for an org-scoped pathname.
 *
 * The first crumb is always the org (display name, linking to the org's
 * Projects page — its de-facto home). Subsequent crumbs follow the pathname
 * segments after `/orgs/:orgSlug/`, using friendly labels for known segments
 * and the raw slug/id for dynamic ones. The final crumb is the current page
 * and carries no href.
 */
export function buildBreadcrumbs(args: {
  orgSlug: string;
  orgName: string;
  pathname: string | null;
}): Crumb[] {
  const { orgSlug, orgName, pathname } = args;
  const base = `/orgs/${orgSlug}`;
  const crumbs: Crumb[] = [{ label: orgName, href: `${base}/projects` }];

  if (!pathname || !pathname.startsWith(`${base}`)) {
    // Foreign path (shouldn't happen inside OrgScope) — org crumb only.
    return [{ label: orgName }];
  }

  const rest = pathname.slice(base.length).split("/").filter(Boolean);
  let href = base;
  for (let i = 0; i < rest.length; i++) {
    const segment = rest[i]!;
    const prev = i > 0 ? rest[i - 1]! : null;
    href += `/${segment}`;
    const isLast = i === rest.length - 1;

    let label = SEGMENT_LABELS[segment];
    let crumbHref: string | undefined = href;
    if (label === undefined) {
      // Dynamic segment (slug/id): label is the raw value; link it onward to
      // its canonical child page when we know one (project → environments).
      label = segment;
      const childSuffix = prev ? DYNAMIC_CHILD_HREF[prev] : undefined;
      crumbHref = childSuffix ? `${href}${childSuffix}` : undefined;
    }

    if (isLast || crumbHref === undefined) crumbs.push({ label });
    else crumbs.push({ label, href: crumbHref });
  }

  // `/orgs/:slug` itself: the org crumb is the page.
  if (rest.length === 0) return [{ label: orgName }];

  return crumbs;
}
