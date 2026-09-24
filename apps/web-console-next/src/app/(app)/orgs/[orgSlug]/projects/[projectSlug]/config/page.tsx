"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfigSurface } from "@/components/config/config-surface";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

export default function ProjectConfigPage() {
  const params = useParams<{ orgSlug: string; projectSlug: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const projectSlug = params?.projectSlug ?? "";
  return (
    <OrgScope slug={orgSlug}>
      {(org) => <Inner orgId={org.id} projectSlug={projectSlug} />}
    </OrgScope>
  );
}

function Inner({ orgId, projectSlug }: { orgId: string; projectSlug: string }) {
  const { client } = useSession();
  const projects = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const project = projects.data?.find((p) => p.slug === projectSlug) ?? null;

  if (projects.loading) return <Skeleton className="h-32 w-full" />;
  if (!project) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Project not found</CardTitle>
          <CardDescription>No project matches “{projectSlug}”.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">Config · {project.name}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Project-scoped settings, feature flags, and secrets. Environment scope lives on each
          environment&apos;s page.
        </p>
      </header>
      <ConfigSurface scope={{ kind: "project", orgId, projectId: project.id }} />
    </div>
  );
}
