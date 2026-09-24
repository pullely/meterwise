"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { z } from "zod";
import { Plus, KeyRound, Copy, Check } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { wrap, type ApiErrorBody } from "@/lib/api";
import { ORGANIZATION_ROLES } from "@saas/contracts/membership";

const schema = z.object({
  label: z.string().min(2).max(64),
  role: z.enum(ORGANIZATION_ROLES),
});

export default function ApiKeysPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const keys = useApiQuery(qk.apiKeys(orgId), () =>
    wrap(async () => (await client.apiKeys.list(orgId)).apiKeys),
  );
  const [open, setOpen] = React.useState(false);
  const [reveal, setReveal] = React.useState<{ label: string; secret: string } | null>(null);
  const [precondition, setPrecondition] = React.useState<ApiErrorBody | null>(null);
  const [copied, setCopied] = React.useState(false);

  const [pendingRevoke, setPendingRevoke] = React.useState<{ id: string; label: string } | null>(
    null,
  );

  const revokeKey = async (id: string) => {
    const r = await wrap(() => client.apiKeys.revoke(orgId, id));
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Key revoked" });
    keys.reload();
  };

  return (
    <div className="space-y-5">
      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => !open && setPendingRevoke(null)}
        title="Revoke API key"
        description="Requests authenticated with this key start failing immediately. This cannot be undone."
        resourceName={pendingRevoke?.label}
        confirmLabel="Revoke key"
        onConfirm={() => (pendingRevoke ? revokeKey(pendingRevoke.id) : undefined)}
      />
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">API keys</h1>
          <p className="text-sm text-muted-foreground">
            Long-lived credentials for service principals. Secrets are shown once at creation.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-1.5" />
              New API key
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>The secret will only be shown once. Store it securely.</DialogDescription>
            </DialogHeader>
            <ZodForm
              schema={schema}
              defaultValues={{ label: "", role: "builder" }}
              fields={[
                { name: "label", label: "Label", placeholder: "ci-deploy-bot" },
                { name: "role", label: "Role", hint: ORGANIZATION_ROLES.join(" · ") },
              ]}
              submitLabel="Create key"
              cancel={{ label: "Cancel", onClick: () => setOpen(false) }}
              onSubmit={async (v) => {
                const r = await wrap(async () =>
                  (await client.apiKeys.create(orgId, { label: v.label, role: v.role })).apiKey,
                );
                if (!r.ok) {
                  if (r.error.code === "precondition_failed") setPrecondition(r.error);
                  else toast({ kind: "error", title: "Create failed", description: r.error.message });
                  return;
                }
                setOpen(false);
                setReveal({ label: r.data.label, secret: r.data.secret });
                keys.reload();
              }}
            />
          </DialogContent>
        </Dialog>
      </header>

      {precondition && (
        <PreconditionInsight error={precondition} resource="api key" onDismiss={() => setPrecondition(null)} />
      )}

      <Dialog open={!!reveal} onOpenChange={(o) => !o && setReveal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>
              This is the only time you’ll see the secret for{" "}
              <span className="font-mono">{reveal?.label}</span>. Copy it now.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-muted p-3 font-mono text-xs break-all border">
            {reveal?.secret}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={async () => {
                if (!reveal) return;
                await navigator.clipboard.writeText(reveal.secret);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check className="h-4 w-4 mr-1.5" /> : <Copy className="h-4 w-4 mr-1.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button onClick={() => setReveal(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {keys.loading ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : keys.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{keys.error.code}</CardTitle>
            <CardDescription>{keys.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !keys.data || keys.data.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys"
          description="Create your first key to authenticate CI, scripts, or service-to-service traffic."
          primaryAction={{ label: "New API key", onClick: () => setOpen(true) }}
        />
      ) : (
        <>
          {/* Mobile: stacked cards */}
          <div className="space-y-3 md:hidden">
            {keys.data.map((k) => (
              <Card key={k.id} className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <div className="truncate font-medium">{k.label}</div>
                    <div className="font-mono text-xs text-muted-foreground">{k.prefix}…</div>
                  </div>
                  {k.revokedAt ? (
                    <Badge variant="destructive">revoked</Badge>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setPendingRevoke({ id: k.id, label: k.label })}>
                      Revoke
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <Badge variant="outline">{k.servicePrincipal.role}</Badge>
                  <span>created {new Date(k.createdAt).toLocaleDateString()}</span>
                  <span>
                    last used {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "never"}
                  </span>
                </div>
              </Card>
            ))}
          </div>

          {/* Desktop: table */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.data.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell className="font-medium">{k.label}</TableCell>
                    <TableCell className="font-mono text-xs">{k.prefix}…</TableCell>
                    <TableCell>
                      <Badge variant="outline">{k.servicePrincipal.role}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(k.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : "never"}
                    </TableCell>
                    <TableCell className="text-right">
                      {!k.revokedAt && (
                        <Button size="sm" variant="ghost" onClick={() => setPendingRevoke({ id: k.id, label: k.label })}>
                          Revoke
                        </Button>
                      )}
                      {k.revokedAt && <Badge variant="destructive">revoked</Badge>}
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
