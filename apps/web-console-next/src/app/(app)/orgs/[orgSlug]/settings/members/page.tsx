"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Users } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";

export default function MembersPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const members = useApiQuery(qk.members(orgId), () =>
    wrap(async () => (await client.memberships.listMembers(orgId)).members),
  );

  const [pendingRemove, setPendingRemove] = React.useState<{ id: string; subjectId: string } | null>(
    null,
  );

  const removeMember = async (id: string) => {
    const r = await wrap(() => client.memberships.removeMember(orgId, id));
    if (!r.ok) {
      toast({ kind: "error", title: "Remove failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Member removed" });
    members.reload();
  };

  return (
    <div className="space-y-5">
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(open) => !open && setPendingRemove(null)}
        title="Remove member"
        description="They immediately lose access to this organization and all of its projects. You can re-invite them later."
        resourceName={pendingRemove?.subjectId}
        confirmLabel="Remove member"
        onConfirm={() => (pendingRemove ? removeMember(pendingRemove.id) : undefined)}
      />
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Members</h1>
        <p className="text-sm text-muted-foreground">Users and service principals attached to this organization.</p>
      </header>

      {members.loading ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : members.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{members.error.code}</CardTitle>
            <CardDescription>{members.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !members.data || members.data.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No members"
          description="Invite teammates from the Invitations page."
          primaryAction={{ label: "Go to invitations", href: `./invitations` }}
        />
      ) : (
        <>
          {/* Mobile: stacked cards */}
          <div className="space-y-3 md:hidden">
            {members.data.map((m) => (
              <Card key={m.id} className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="break-all font-mono text-xs">{m.subjectId}</div>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="secondary">{m.subjectType}</Badge>
                      <Badge variant={m.status === "active" ? "success" : "warning"}>{m.status}</Badge>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setPendingRemove({ id: m.id, subjectId: m.subjectId })}>
                    Remove
                  </Button>
                </div>
                {m.roles.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {m.roles.map((r, i) => (
                      <Badge key={i} variant="outline">
                        {r.role}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  Joined {new Date(m.joinedAt).toLocaleDateString()}
                </div>
              </Card>
            ))}
          </div>

          {/* Desktop: table */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.data.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-mono text-xs">{m.subjectId}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{m.subjectType}</Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {m.roles.map((r, i) => (
                          <Badge key={i} variant="outline">
                            {r.role}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={m.status === "active" ? "success" : "warning"}>{m.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(m.joinedAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setPendingRemove({ id: m.id, subjectId: m.subjectId })}>
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}
