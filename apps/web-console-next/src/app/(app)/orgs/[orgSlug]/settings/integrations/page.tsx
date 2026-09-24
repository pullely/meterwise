"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { Github, GitBranch, Plug } from "lucide-react";
import type { PublicConnection } from "@saas/contracts/integrations";
import { OrgScope } from "@/components/shell/org-scope";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PreconditionInsight } from "@/components/precondition/insight";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import {
  connectionDisplayName,
  connectionStatusMeta,
  hasPendingConnection,
  visibleConnections,
} from "@/components/integrations/connections";

const POLL_INTERVAL_MS = 2500;
const POLL_BUDGET_MS = 11 * 60 * 1000; // connect state TTL (10 min) + margin

export default function IntegrationsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const router = useRouter();

  const list = useApiQuery(qk.integrations(orgId), () =>
    wrap(async () => (await client.integrations.list(orgId)).connections),
  );

  const [connecting, setConnecting] = React.useState(false);
  const [gateError, setGateError] = React.useState<ApiErrorBody | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<PublicConnection | null>(null);
  const pollUntil = React.useRef<number>(0);

  const connections = list.data ?? [];
  const visible = visibleConnections(connections);
  const hasActive = connections.some((c) => c.status === "active");

  // While a connect popup is in flight (or a pending row exists), poll the
  // list so the row flips to Active without a manual refresh.
  const shouldPoll =
    (connecting || hasPendingConnection(connections)) && Date.now() < pollUntil.current;
  React.useEffect(() => {
    if (!shouldPoll) return;
    const t = setInterval(() => list.reload(), POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [shouldPoll, list]);

  React.useEffect(() => {
    if (connecting && hasActive) {
      setConnecting(false);
      toast({ kind: "success", title: "GitHub connected" });
    }
  }, [connecting, hasActive, toast]);

  const connect = async () => {
    setGateError(null);
    const r = await wrap(() => client.integrations.connectGithub(orgId));
    if (!r.ok) {
      if (r.status === 412) {
        setGateError(r.error);
      } else {
        toast({ kind: "error", title: "Could not start the connection", description: r.error.message });
      }
      return;
    }
    pollUntil.current = Date.now() + POLL_BUDGET_MS;
    setConnecting(true);
    list.reload();
    const popup = window.open(r.data.installUrl, "github-connect", "width=1020,height=780");
    if (!popup) {
      // Popup blocked — same flow, same tab.
      window.location.assign(r.data.installUrl);
    }
  };

  const revoke = async (connection: PublicConnection) => {
    const r = await wrap(() => client.integrations.revoke(orgId, connection.id));
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Connection revoked" });
    list.reload();
  };

  return (
    <div className="space-y-5">
      <header>
        <div className="flex items-center gap-2">
          <Plug className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">Integrations</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Connect external providers to this organization. Repositories link to projects from each
          project&apos;s Git settings once a provider is connected.
        </p>
      </header>

      {gateError ? (
        <PreconditionInsight
          error={gateError}
          resource="integration"
          onUpgrade={() => router.push(`/orgs/${orgSlug}/settings/billing`)}
          onDismiss={() => setGateError(null)}
        />
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-card">
              <Github className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">GitHub</CardTitle>
              <CardDescription>
                Install the GitHub App to react to pushes and pull requests, link repositories to
                projects, and act on GitHub without storing credentials.
              </CardDescription>
            </div>
          </div>
          <Button onClick={() => void connect()} disabled={connecting}>
            {connecting ? "Waiting for GitHub…" : hasActive ? "Connect another" : "Connect"}
          </Button>
        </CardHeader>
        <CardContent>
          {list.loading ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : list.error ? (
            <div className="py-2">
              <div className="text-sm font-medium text-destructive">Failed to load connections</div>
              <div className="text-xs text-muted-foreground">{list.error.message}</div>
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title="No GitHub connection yet"
              description="Connect a GitHub organization or account to start linking repositories to projects."
              primaryAction={{ label: "Connect GitHub", onClick: () => void connect() }}
            />
          ) : (
            <ul className="divide-y divide-border">
              {visible.map((connection) => {
                const meta = connectionStatusMeta(connection.status);
                return (
                  <li key={connection.id} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">
                          {connectionDisplayName(connection)}
                        </span>
                        <Badge variant={meta.tone === "default" ? "secondary" : meta.tone}>
                          {meta.label}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {connection.externalAccountType ?? "GitHub"}
                        {connection.connectedAt
                          ? ` · connected ${new Date(connection.connectedAt).toLocaleDateString()}`
                          : connection.status === "pending"
                            ? " · waiting for the GitHub install to finish"
                            : ""}
                      </div>
                    </div>
                    {connection.status !== "revoked" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRevokeTarget(connection)}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke GitHub connection?"
        description="The platform stops receiving events for this installation and any linked repositories stop updating. This also uninstalls the App from GitHub when possible."
        resourceName={revokeTarget ? connectionDisplayName(revokeTarget) : undefined}
        confirmLabel="Revoke connection"
        onConfirm={async () => {
          if (revokeTarget) await revoke(revokeTarget);
        }}
      />
    </div>
  );
}
