"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Webhook, ArrowRight, Plus } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { CreateEndpointDialog } from "@/components/webhooks/create-endpoint-dialog";

export default function WebhooksListPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => <Inner orgId={org.id} orgSlug={org.slug} />}
    </OrgScope>
  );
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const router = useRouter();
  const endpoints = useApiQuery(qk.webhooks(orgId), () =>
    wrap(async () => (await client.webhooks.listEndpoints(orgId)).endpoints),
  );
  const [createOpen, setCreateOpen] = React.useState(false);

  const handleCreated = React.useCallback(
    (endpointId: string) => {
      router.push(`/orgs/${orgSlug}/settings/webhooks/${endpointId}`);
    },
    [router, orgSlug],
  );

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Webhooks</h1>
          <p className="text-sm text-muted-foreground">
            Endpoints that receive signed event deliveries from this organization.
            Open an endpoint to inspect its signing-secret version or rotate it.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          New endpoint
        </Button>
      </header>

      {endpoints.loading ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : endpoints.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{endpoints.error.code}</CardTitle>
            <CardDescription>{endpoints.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !endpoints.data || endpoints.data.length === 0 ? (
        <EmptyState
          icon={Webhook}
          title="No webhook endpoints"
          description="Create your first endpoint to start receiving signed event deliveries from this organization."
          primaryAction={{ label: "Create endpoint", onClick: () => setCreateOpen(true) }}
        />
      ) : (
        <>
          {/* Mobile: stacked cards */}
          <div className="space-y-3 md:hidden">
            {endpoints.data.map((ep) => (
              <Link
                key={ep.id}
                href={`/orgs/${orgSlug}/settings/webhooks/${ep.id}`}
                className="block"
              >
                <Card className="space-y-2 p-4 transition-colors active:bg-accent/40">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {ep.name && <div className="truncate text-sm font-medium">{ep.name}</div>}
                      <div className="break-all font-mono text-xs text-muted-foreground">{ep.url}</div>
                    </div>
                    <Badge variant={ep.status === "active" ? "outline" : "destructive"}>
                      {ep.status}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>secret v{ep.secretVersion}</span>
                    <span>
                      rotated{" "}
                      {ep.secretLastRotatedAt
                        ? new Date(ep.secretLastRotatedAt).toLocaleDateString()
                        : "never"}
                    </span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>

          {/* Desktop: table */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>URL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Secret version</TableHead>
                  <TableHead>Last rotated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.data.map((ep) => (
                <TableRow key={ep.id}>
                  <TableCell className="font-mono text-xs break-all max-w-[26rem]">
                    {ep.name ? (
                      <span>
                        <span className="font-sans font-medium not-italic">{ep.name}</span>
                        <span className="text-muted-foreground"> · </span>
                        {ep.url}
                      </span>
                    ) : (
                      ep.url
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={ep.status === "active" ? "outline" : "destructive"}>
                      {ep.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">v{ep.secretVersion}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {ep.secretLastRotatedAt
                      ? new Date(ep.secretLastRotatedAt).toLocaleDateString()
                      : "never"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/orgs/${orgSlug}/settings/webhooks/${ep.id}`}
                      className="text-xs font-medium inline-flex items-center gap-1 text-primary hover:underline"
                    >
                      Open
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      <CreateEndpointDialog
        orgId={orgId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />
    </div>
  );
}
