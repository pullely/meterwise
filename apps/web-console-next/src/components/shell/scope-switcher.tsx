"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ChevronsUpDown, Slash, Building2, FolderKanban, Boxes } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { useApiQuery, qk } from "@/lib/query";

/**
 * URL-driven scope switcher.
 *
 * - Reads org/project/env slugs from the URL params (NOT sessionStorage).
 * - Surfaces the multi-tenant scope on every page so tenant isolation is
 *   always visible to the operator.
 * - Lets the user jump scopes via a single dropdown; selection re-writes the
 *   URL, never local state.
 */
export function ScopeSwitcher() {
  const params = useParams<{ orgSlug?: string; projectSlug?: string; envSlug?: string }>();
  const router = useRouter();
  const { client, token } = useSession();

  const orgSlug = params?.orgSlug ?? null;
  const projectSlug = params?.projectSlug ?? null;
  const envSlug = params?.envSlug ?? null;

  // PERF11: the org/project/env lists are read through react-query so the topbar
  // reuses the page caches (no uncached refetch on every mount), with each level
  // gated on the previous resolving. Keys mirror the page queries exactly.
  const orgs = useApiQuery(
    qk.orgs(),
    () => wrap(async () => (await client.organizations.list()).organizations),
    { enabled: !!token },
  ).data;
  const currentOrg = React.useMemo(() => orgs?.find((o) => o.slug === orgSlug) ?? null, [orgs, orgSlug]);

  const projectsData = useApiQuery(
    qk.projects(currentOrg?.id ?? ""),
    () => wrap(async () => (await client.projects.list(currentOrg!.id)).projects),
    { enabled: !!currentOrg },
  ).data;
  const projects = currentOrg ? projectsData : null;
  const currentProject = React.useMemo(
    () => projects?.find((p) => p.slug === projectSlug) ?? null,
    [projects, projectSlug],
  );

  const envsData = useApiQuery(
    qk.environments(currentOrg?.id ?? "", currentProject?.id ?? ""),
    () =>
      wrap(async () => (await client.environments.list(currentOrg!.id, currentProject!.id)).environments),
    { enabled: !!currentOrg && !!currentProject },
  ).data;
  const envs = currentOrg && currentProject ? envsData : null;

  return (
    <div className="flex min-w-0 items-center gap-1 text-sm">
      {/* Org lives in the sidebar switcher on desktop; the topbar shows it only
          on small screens (the drawer has no persistent org switcher). */}
      <div className="flex min-w-0 md:hidden">
        <Crumb
          icon={<Building2 className="h-3.5 w-3.5" />}
          label={currentOrg?.name ?? orgSlug ?? "Select organization"}
          muted={!orgSlug}
        >
          {orgs?.length ? (
            <>
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {orgs.map((o) => (
                <DropdownMenuItem key={o.id} onSelect={() => router.push(`/orgs/${o.slug}/projects`)}>
                  <Building2 className="h-4 w-4 opacity-70" /> {o.name}
                  <span className="ml-auto text-[10px] text-muted-foreground">{o.slug}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem onSelect={() => router.push("/orgs")}>View all organizations…</DropdownMenuItem>
        </Crumb>
      </div>

      {orgSlug && (
        <div className="hidden min-w-0 items-center md:flex">
          {/* Separator only needed to the org crumb, which is mobile-only. */}
          <Slash className="mx-0.5 h-3 w-3 text-muted-foreground/60 md:hidden" />
          <Crumb
            icon={<FolderKanban className="h-3.5 w-3.5" />}
            label={currentProject?.name ?? projectSlug ?? "Select project"}
            muted={!projectSlug}
          >
            {projects?.length ? (
              <>
                <DropdownMenuLabel>Projects</DropdownMenuLabel>
                {projects.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onSelect={() =>
                      router.push(`/orgs/${orgSlug}/projects/${p.slug}/environments`)
                    }
                  >
                    <FolderKanban className="h-4 w-4 opacity-70" /> {p.name}
                    <span className="ml-auto text-[10px] text-muted-foreground">{p.slug}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem onSelect={() => router.push(`/orgs/${orgSlug}/projects`)}>
              View all projects…
            </DropdownMenuItem>
          </Crumb>
        </div>
      )}

      {orgSlug && projectSlug && (
        <div className="hidden min-w-0 items-center md:flex">
          <Slash className="h-3 w-3 text-muted-foreground/60 mx-0.5" />
          <Crumb
            icon={<Boxes className="h-3.5 w-3.5" />}
            label={envs?.find((e) => e.slug === envSlug)?.name ?? envSlug ?? "All environments"}
            muted={!envSlug}
          >
            {envs?.length ? (
              <>
                <DropdownMenuLabel>Environments</DropdownMenuLabel>
                {envs.map((e) => (
                  <DropdownMenuItem
                    key={e.id}
                    onSelect={() =>
                      router.push(`/orgs/${orgSlug}/projects/${projectSlug}/environments/${e.slug}`)
                    }
                  >
                    <Boxes className="h-4 w-4 opacity-70" /> {e.name}
                    <span className="ml-auto text-[10px] text-muted-foreground">{e.slug}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              onSelect={() => router.push(`/orgs/${orgSlug}/projects/${projectSlug}/environments`)}
            >
              View all environments…
            </DropdownMenuItem>
          </Crumb>
        </div>
      )}
    </div>
  );
}

function Crumb({
  icon,
  label,
  muted,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "group inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm border border-transparent",
          "hover:bg-accent hover:border-border transition-colors",
          muted && "text-muted-foreground",
        )}
      >
        {icon}
        <span className="max-w-[44vw] truncate font-medium sm:max-w-[160px]">{label}</span>
        <ChevronsUpDown className="h-3 w-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

void Link;
