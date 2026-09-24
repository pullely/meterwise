"use client";

import * as React from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { ChevronsUpDown } from "lucide-react";
import {
  buildSettingsNav,
  flattenSettingsNav,
  isSettingsLinkActive,
} from "@/components/shell/settings-nav";

/**
 * Mobile-only settings section switcher. On `md+` the settings nav lives in the
 * sidebar; on phones (where the sidebar is a drawer) this native `<select>`
 * sits at the top of the content so users can jump between settings pages
 * without opening the drawer. A native select gives the best mobile picker UX.
 */
export function SettingsMobileSwitcher() {
  const params = useParams<{ orgSlug: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const orgSlug = params?.orgSlug ?? "";
  const links = flattenSettingsNav(buildSettingsNav(orgSlug));
  const current = links.find((l) => isSettingsLinkActive(l, pathname))?.href ?? links[0]?.href;

  return (
    <div className="relative mb-6 md:hidden">
      <select
        aria-label="Settings section"
        value={current}
        onChange={(e) => router.push(e.target.value)}
        className="h-11 w-full appearance-none rounded-md border border-input bg-card px-3 pr-10 text-base font-medium text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {links.map((link) => (
          <option key={link.href} value={link.href}>
            {link.label}
          </option>
        ))}
      </select>
      <ChevronsUpDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
