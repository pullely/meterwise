"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { z } from "zod";
import { Plus, Mail } from "lucide-react";
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
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { PreconditionInsight } from "@/components/precondition/insight";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { ORGANIZATION_ROLES } from "@saas/contracts/membership";
import { wrap, type ApiErrorBody } from "@/lib/api";

const schema = z.object({
  email: z.string().email("Enter a valid email"),
  role: z.enum(ORGANIZATION_ROLES),
});

export default function InvitationsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const invs = useApiQuery(qk.invitations(orgId), () =>
    wrap(async () => (await client.memberships.listInvitations(orgId)).invitations),
  );
  const [open, setOpen] = React.useState(false);
  const [precondition, setPrecondition] = React.useState<ApiErrorBody | null>(null);

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Invitations</h1>
          <p className="text-sm text-muted-foreground">Pending and historical invites for this organization.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-1.5" />
              Invite member
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Send invitation</DialogTitle>
              <DialogDescription>
                Invite a teammate by email to join this organization.
              </DialogDescription>
            </DialogHeader>
            <ZodForm
              schema={schema}
              defaultValues={{ email: "", role: "viewer" }}
              fields={[
                { name: "email", label: "Email", type: "email", placeholder: "user@example.com" },
                { name: "role", label: "Role", hint: ORGANIZATION_ROLES.join(" · ") },
              ]}
              submitLabel="Send invite"
              cancel={{ label: "Cancel", onClick: () => setOpen(false) }}
              onSubmit={async (v) => {
                const r = await wrap(() =>
                  client.memberships.createInvitation(orgId, { email: v.email, role: v.role }),
                );
                if (!r.ok) {
                  if (r.error.code === "precondition_failed") setPrecondition(r.error);
                  else toast({ kind: "error", title: "Invite failed", description: r.error.message });
                  return;
                }
                toast({
                  kind: "success",
                  title: "Invitation sent",
                  description: r.data.delivery?.token ? `dev token: ${r.data.delivery.token}` : undefined,
                });
                setOpen(false);
                invs.reload();
              }}
            />
          </DialogContent>
        </Dialog>
      </header>

      {precondition && (
        <PreconditionInsight error={precondition} resource="invitation" onDismiss={() => setPrecondition(null)} />
      )}

      {invs.loading ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : invs.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{invs.error.code}</CardTitle>
            <CardDescription>{invs.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !invs.data || invs.data.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No invitations"
          description="Invite teammates to collaborate in this organization."
          primaryAction={{ label: "Invite member", onClick: () => setOpen(true) }}
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invs.data.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium">{i.email}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{i.role}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        i.status === "pending"
                          ? "warning"
                          : i.status === "accepted"
                            ? "success"
                            : "secondary"
                      }
                    >
                      {i.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(i.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(i.expiresAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {i.status === "pending" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          const r = await wrap(() =>
                            client.memberships.revokeInvitation(orgId, i.id),
                          );
                          if (!r.ok) {
                            toast({ kind: "error", title: "Revoke failed", description: r.error.message });
                            return;
                          }
                          toast({ kind: "success", title: "Invitation revoked" });
                          invs.reload();
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
