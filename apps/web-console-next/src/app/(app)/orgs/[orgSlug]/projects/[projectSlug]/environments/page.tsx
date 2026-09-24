"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { z } from "zod";
import { Plus, Boxes } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ZodForm } from "@/components/ui/zod-form";
import { PreconditionInsight } from "@/components/precondition/insight";
import { ArchiveMenu } from "@/components/settings/archive-menu";
import { removeById } from "@/components/settings/archive";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";
import type { PublicEnvironment } from "@saas/contracts/projects";

const schema = z.object({
  name: z.string().min(2).max(48),
  slug: z.string().regex(/^[a-z0-9-]*$/, "lowercase, digits, hyphens").max(32).optional(),
});

export default function EnvironmentsPage() {
  const params = useParams<{ orgSlug: string; projectSlug: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const projectSlug = params?.projectSlug ?? "";
  return (
    <OrgScope slug={orgSlug}>
      {(org) => <Inner orgId={org.id} orgSlug={orgSlug} projectSlug={projectSlug} />}
    </OrgScope>
  );
}

function Inner({ orgId, orgSlug, projectSlug }: { orgId: string; orgSlug: string; projectSlug: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Shares the `projects` cache key with the projects list page, so navigating
  // project-list → environments resolves the project synchronously from cache.
  const projectsList = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const project = React.useMemo(
    () => projectsList.data?.find((p) => p.slug === projectSlug) ?? null,
    [projectsList.data, projectSlug],
  );

  const envKey = qk.environments(orgId, project?.id ?? "pending");
  const envs = useApiQuery(
    envKey,
    () => wrap(async () => (await client.environments.list(orgId, project!.id)).environments),
    { enabled: !!project },
  );

  const [open, setOpen] = React.useState(false);
  const [precondition, setPrecondition] = React.useState<ApiErrorBody | null>(null);

  // The query cache is the source of truth; archive mutates it optimistically.
  const items = envs.data ?? [];

  const archive = async (env: PublicEnvironment) => {
    if (!project) return;
    const previous = qc.getQueryData<PublicEnvironment[]>(envKey);
    qc.setQueryData<PublicEnvironment[]>(envKey, (cur) => removeById(cur ?? [], env.id)); // optimistic
    const r = await wrap(() => client.environments.archive(orgId, project.id, env.id));
    if (!r.ok) {
      qc.setQueryData<PublicEnvironment[]>(envKey, previous); // rollback
      toast({ kind: "error", title: "Archive failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `Archived ${env.name}` });
  };

  if (projectsList.loading) {
    return <Skeleton className="h-24 w-full" />;
  }
  if (!project) {
    return (
      <EmptyState
        title="Project not found"
        description={`No project matches slug “${projectSlug}”.`}
        primaryAction={{ label: "Back to projects", href: `/orgs/${orgSlug}/projects` }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Environments <span className="text-muted-foreground font-normal">· {project.name}</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Deployment targets within this project. Each gets isolated config and bindings.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-1.5" />
              New environment
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create environment</DialogTitle>
              <DialogDescription>
                Environments are isolated deployment targets within this project.
              </DialogDescription>
            </DialogHeader>
            <ZodForm
              schema={schema}
              defaultValues={{ name: "", slug: "" }}
              fields={[
                { name: "name", label: "Name", placeholder: "Production" },
                { name: "slug", label: "Slug", placeholder: "prod", hint: "Lowercased URL identifier." },
              ]}
              submitLabel="Create"
              cancel={{ label: "Cancel", onClick: () => setOpen(false) }}
              onSubmit={async (v) => {
                const payload: { name: string; slug?: string } = { name: v.name };
                if (v.slug) payload.slug = v.slug;
                const r = await wrap(async () =>
                  (await client.environments.create(orgId, project.id, payload)).environment,
                );
                if (!r.ok) {
                  if (r.error.code === "precondition_failed") setPrecondition(r.error);
                  else toast({ kind: "error", title: "Create failed", description: r.error.message });
                  return;
                }
                toast({ kind: "success", title: "Environment created" });
                setOpen(false);
                envs.reload();
              }}
            />
          </DialogContent>
        </Dialog>
      </header>

      {precondition && (
        <PreconditionInsight
          error={precondition}
          resource="environment"
          onDismiss={() => setPrecondition(null)}
        />
      )}

      {envs.loading ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24 mt-2" />
              </CardHeader>
            </Card>
          ))}
        </div>
      ) : envs.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{envs.error.code}</CardTitle>
            <CardDescription>{envs.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No environments"
          description="Create dev/stage/prod to begin deploying."
          primaryAction={{ label: "New environment", onClick: () => setOpen(true) }}
        />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((e) => (
            <div key={e.id} className="relative">
              <div className="absolute right-3 top-3 z-10">
                <ArchiveMenu
                  resourceLabel="environment"
                  name={e.name}
                  onConfirm={() => archive(e)}
                />
              </div>
              <Link
                href={`/orgs/${orgSlug}/projects/${projectSlug}/environments/${e.slug}`}
                className="group block"
              >
                <Card className="h-full transition-shadow group-hover:shadow-md group-hover:border-primary/40">
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2 pr-8">
                      <CardTitle className="text-base truncate">{e.name}</CardTitle>
                      <Badge variant={e.status === "active" ? "success" : "secondary"}>{e.status}</Badge>
                    </div>
                    <CardDescription className="text-xs">{e.slug}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="text-xs text-muted-foreground">
                      Updated {new Date(e.updatedAt).toLocaleDateString()}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
