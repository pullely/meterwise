"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { ChevronsUpDown, Check, Plus, Building2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { useApiQuery, qk } from "@/lib/query";
import { SOLO_MODE } from "@/lib/solo-mode";

/**
 * Org switcher anchored at the top of the sidebar (Vercel's team-switcher
 * pattern): the current org as an avatar + name, opening a dropdown of orgs to
 * switch between, plus shortcuts to the full list and creating one.
 */
export function SidebarOrgSwitcher({ onNavigate }: { onNavigate?: () => void } = {}) {
  const params = useParams<{ orgSlug?: string }>();
  const router = useRouter();
  const { client, token } = useSession();
  const orgSlug = params?.orgSlug ?? null;
  // Shared `orgs` query (PERF11): reuses the same cache entry as the page list
  // and `useOrgBySlug`, so the shell paints from cache and never fires a
  // duplicate org-list request on mount.
  const orgs =
    useApiQuery(
      qk.orgs(),
      () => wrap(async () => (await client.organizations.list()).organizations),
      { enabled: !!token },
    ).data;
  const go = (href: string) => {
    onNavigate?.();
    router.push(href);
  };

  const current = orgs?.find((o) => o.slug === orgSlug) ?? null;
  const label = current?.name ?? orgSlug ?? (SOLO_MODE ? "Account" : "Select organization");
  const seed = (label.trim()[0] ?? "S").toUpperCase();

  // Solo profile: there is exactly one (invisible) workspace, so there is no
  // switching, no "view all", and no "create org". Render a static account
  // chip instead of the switcher dropdown.
  if (SOLO_MODE) {
    return (
      <div className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-gradient-to-br from-primary to-primary/40 text-xs font-bold text-primary-foreground">
          {seed}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{label}</span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-gradient-to-br from-primary to-primary/40 text-xs font-bold text-primary-foreground">
          {seed}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{label}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {orgs?.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => go(`/orgs/${o.slug}/projects`)}>
            <Building2 className="h-4 w-4 opacity-70" />
            <span className="truncate">{o.name}</span>
            {o.slug === orgSlug && <Check className="ml-auto h-4 w-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => go("/orgs")}>
          View all organizations…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go("/orgs")}>
          <Plus className="h-4 w-4 opacity-70" /> Create organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
