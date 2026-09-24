"use client";

import * as React from "react";
import { z } from "zod";
import { Plus, SlidersHorizontal, Flag, Lock } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConfigScope } from "@saas/sdk";
import type {
  PublicSetting,
  PublicFeatureFlag,
  PublicSecretMetadata,
} from "@saas/contracts/config";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { ZodForm } from "@/components/ui/zod-form";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { parseConfigValueInput, formatConfigValue, configScopeKey } from "./value";

/**
 * The console face of config-worker: settings, feature flags, and secrets at
 * any of the three scopes (organization / project / environment). One shared
 * surface so all scopes behave identically; the page supplies the scope.
 *
 * Secrets are write-only on the wire: list/read responses carry metadata
 * only, and this surface never renders secret material after the create /
 * rotate dialog closes.
 */
export function ConfigSurface({ scope }: { scope: ConfigScope }) {
  const scopeKey = configScopeKey(scope);
  return (
    <Tabs defaultValue="settings">
      <TabsList>
        <TabsTrigger value="settings">Settings</TabsTrigger>
        <TabsTrigger value="flags">Feature flags</TabsTrigger>
        <TabsTrigger value="secrets">Secrets</TabsTrigger>
      </TabsList>
      <TabsContent value="settings" className="pt-4">
        <SettingsTab scope={scope} scopeKey={scopeKey} />
      </TabsContent>
      <TabsContent value="flags" className="pt-4">
        <FlagsTab scope={scope} scopeKey={scopeKey} />
      </TabsContent>
      <TabsContent value="secrets" className="pt-4">
        <SecretsTab scope={scope} scopeKey={scopeKey} />
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settingSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.string().min(1),
  description: z.string().max(256).optional(),
});
const settingEditSchema = settingSchema.omit({ key: true });

function SettingsTab({ scope, scopeKey }: { scope: ConfigScope; scopeKey: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const settings = useApiQuery(qk.configSettings(scopeKey), () =>
    wrap(async () => (await client.config.listSettings(scope)).settings),
  );
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<PublicSetting | null>(null);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Key–value configuration. Values accept JSON literals or plain strings.
        </p>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New setting
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create setting</DialogTitle>
              <DialogDescription>Scoped to this {scope.kind}.</DialogDescription>
            </DialogHeader>
            <ZodForm
              schema={settingSchema}
              defaultValues={{ key: "", value: "", description: "" }}
              fields={[
                { name: "key", label: "Key", placeholder: "default_region" },
                { name: "value", label: "Value", placeholder: '"eu-west-1" or {"a":1} or 42', hint: "Valid JSON is stored typed; anything else as a string." },
                { name: "description", label: "Description", placeholder: "Optional" },
              ]}
              submitLabel="Create setting"
              cancel={{ label: "Cancel", onClick: () => setCreateOpen(false) }}
              onSubmit={async (v) => {
                const r = await wrap(() =>
                  client.config.createSetting(scope, {
                    key: v.key,
                    value: parseConfigValueInput(v.value),
                    description: v.description || null,
                  }),
                );
                if (!r.ok) {
                  toast({ kind: "error", title: "Create failed", description: r.error.message });
                  return;
                }
                setCreateOpen(false);
                toast({ kind: "success", title: "Setting created" });
                settings.reload();
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit setting</DialogTitle>
            <DialogDescription className="font-mono text-xs">{editing?.key}</DialogDescription>
          </DialogHeader>
          {editing ? (
            <ZodForm
              schema={settingEditSchema}
              defaultValues={{
                value: formatConfigValue(editing.value),
                description: editing.description ?? "",
              }}
              fields={[
                { name: "value", label: "Value" },
                { name: "description", label: "Description" },
              ]}
              submitLabel="Save changes"
              cancel={{ label: "Cancel", onClick: () => setEditing(null) }}
              onSubmit={async (v) => {
                const r = await wrap(() =>
                  // Item routes address by public id (set_…), not key — the
                  // worker's parseSettingPublicId rejects bare keys (live 404).
                  client.config.updateSetting(scope, editing.id, {
                    value: parseConfigValueInput(v.value),
                    description: v.description || null,
                  }),
                );
                if (!r.ok) {
                  toast({ kind: "error", title: "Save failed", description: r.error.message });
                  return;
                }
                setEditing(null);
                toast({ kind: "success", title: "Setting updated" });
                settings.reload();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {settings.loading ? (
        <ListSkeleton />
      ) : settings.error ? (
        <LoadError title="Failed to load settings" message={settings.error.message} />
      ) : !settings.data || settings.data.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="No settings yet"
          description="Create your first key–value setting for this scope. Available instantly via the API and SDK."
          primaryAction={{ label: "New setting", onClick: () => setCreateOpen(true) }}
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="hidden md:table-cell">Description</TableHead>
                <TableHead className="hidden md:table-cell">Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {settings.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs">{s.key}</TableCell>
                  <TableCell className="max-w-[260px] truncate font-mono text-xs">
                    {formatConfigValue(s.value)}
                  </TableCell>
                  <TableCell className="hidden max-w-[220px] truncate text-xs text-muted-foreground md:table-cell">
                    {s.description ?? "—"}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {new Date(s.updatedAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                      Edit
                    </Button>
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

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

const flagSchema = z.object({
  flagKey: z.string().min(1).max(128),
  description: z.string().max(256).optional(),
});

function FlagsTab({ scope, scopeKey }: { scope: ConfigScope; scopeKey: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const qc = useQueryClient();
  const key = qk.configFlags(scopeKey);
  const flags = useApiQuery(key, () =>
    wrap(async () => (await client.config.listFeatureFlags(scope)).featureFlags),
  );
  const [createOpen, setCreateOpen] = React.useState(false);

  // Optimistic toggle: flip in cache, roll back on error.
  const toggle = async (flag: PublicFeatureFlag, enabled: boolean) => {
    const previous = qc.getQueryData<PublicFeatureFlag[]>(key);
    qc.setQueryData<PublicFeatureFlag[]>(key, (cur) =>
      (cur ?? []).map((f) => (f.id === flag.id ? { ...f, enabled } : f)),
    );
    // Address by public id (flg_…): the worker's item route rejects bare keys.
    const r = await wrap(() => client.config.updateFeatureFlag(scope, flag.id, { enabled }));
    if (!r.ok) {
      qc.setQueryData<PublicFeatureFlag[]>(key, previous);
      toast({ kind: "error", title: "Toggle failed", description: r.error.message });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Toggles your product reads at runtime. Changes apply immediately.
        </p>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New flag
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create feature flag</DialogTitle>
              <DialogDescription>Created disabled; flip it on when ready.</DialogDescription>
            </DialogHeader>
            <ZodForm
              schema={flagSchema}
              defaultValues={{ flagKey: "", description: "" }}
              fields={[
                { name: "flagKey", label: "Flag key", placeholder: "new_dashboard" },
                { name: "description", label: "Description", placeholder: "Optional" },
              ]}
              submitLabel="Create flag"
              cancel={{ label: "Cancel", onClick: () => setCreateOpen(false) }}
              onSubmit={async (v) => {
                const r = await wrap(() =>
                  client.config.createFeatureFlag(scope, {
                    flagKey: v.flagKey,
                    enabled: false,
                    description: v.description || null,
                  }),
                );
                if (!r.ok) {
                  toast({ kind: "error", title: "Create failed", description: r.error.message });
                  return;
                }
                setCreateOpen(false);
                toast({ kind: "success", title: "Flag created" });
                flags.reload();
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {flags.loading ? (
        <ListSkeleton />
      ) : flags.error ? (
        <LoadError title="Failed to load feature flags" message={flags.error.message} />
      ) : !flags.data || flags.data.length === 0 ? (
        <EmptyState
          icon={Flag}
          title="No feature flags yet"
          description="Gate features per organization, project, or environment — flip them without a deploy."
          primaryAction={{ label: "New flag", onClick: () => setCreateOpen(true) }}
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[60px]">On</TableHead>
                <TableHead>Flag</TableHead>
                <TableHead className="hidden md:table-cell">Description</TableHead>
                <TableHead className="hidden md:table-cell">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flags.data.map((f) => (
                <TableRow key={f.id}>
                  <TableCell>
                    <Switch
                      checked={f.enabled}
                      onCheckedChange={(on) => void toggle(f, on)}
                      aria-label={`Toggle ${f.flagKey}`}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{f.flagKey}</TableCell>
                  <TableCell className="hidden max-w-[260px] truncate text-xs text-muted-foreground md:table-cell">
                    {f.description ?? "—"}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {new Date(f.updatedAt).toLocaleDateString()}
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

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const secretSchema = z.object({
  secretKey: z.string().min(1).max(128),
  value: z.string().min(1),
  displayName: z.string().max(128).optional(),
});
const rotateSchema = z.object({ value: z.string().min(1) });

function SecretsTab({ scope, scopeKey }: { scope: ConfigScope; scopeKey: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const secrets = useApiQuery(qk.configSecrets(scopeKey), () =>
    wrap(async () => (await client.config.listSecretMetadata(scope)).secrets),
  );
  const [createOpen, setCreateOpen] = React.useState(false);
  const [rotating, setRotating] = React.useState<PublicSecretMetadata | null>(null);
  const [revoking, setRevoking] = React.useState<PublicSecretMetadata | null>(null);

  const revoke = async (secretId: string) => {
    // Address by public id (sec_…): the worker's item route rejects bare keys.
    const r = await wrap(() => client.config.revokeSecret(scope, secretId));
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Secret revoked" });
    secrets.reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Values are encrypted at rest and write-only — they never appear here again.
        </p>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New secret
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create secret</DialogTitle>
              <DialogDescription>
                The value is encrypted before storage and never shown again — keep your own copy.
              </DialogDescription>
            </DialogHeader>
            <ZodForm
              schema={secretSchema}
              defaultValues={{ secretKey: "", value: "", displayName: "" }}
              fields={[
                { name: "secretKey", label: "Key", placeholder: "stripe_api_key" },
                { name: "value", label: "Value", type: "password", autoComplete: "off" },
                { name: "displayName", label: "Display name", placeholder: "Optional" },
              ]}
              submitLabel="Create secret"
              cancel={{ label: "Cancel", onClick: () => setCreateOpen(false) }}
              onSubmit={async (v) => {
                const r = await wrap(() =>
                  client.config.createSecretMetadata(scope, {
                    secretKey: v.secretKey,
                    value: v.value,
                    displayName: v.displayName || null,
                  }),
                );
                if (!r.ok) {
                  toast({ kind: "error", title: "Create failed", description: r.error.message });
                  return;
                }
                setCreateOpen(false);
                toast({ kind: "success", title: "Secret stored", description: "The value is encrypted and not retrievable." });
                secrets.reload();
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      <Dialog open={rotating !== null} onOpenChange={(o) => !o && setRotating(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate secret</DialogTitle>
            <DialogDescription className="font-mono text-xs">{rotating?.secretKey}</DialogDescription>
          </DialogHeader>
          {rotating ? (
            <ZodForm
              schema={rotateSchema}
              defaultValues={{ value: "" }}
              fields={[{ name: "value", label: "New value", type: "password", autoComplete: "off" }]}
              submitLabel="Rotate"
              cancel={{ label: "Cancel", onClick: () => setRotating(null) }}
              onSubmit={async (v) => {
                const r = await wrap(() =>
                  client.config.rotateSecret(scope, rotating.id, { value: v.value }),
                );
                if (!r.ok) {
                  toast({ kind: "error", title: "Rotate failed", description: r.error.message });
                  return;
                }
                setRotating(null);
                toast({ kind: "success", title: "Secret rotated" });
                secrets.reload();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke secret"
        description="Consumers reading this secret stop resolving it immediately. This cannot be undone."
        resourceName={revoking?.secretKey}
        confirmLabel="Revoke secret"
        onConfirm={() => (revoking ? revoke(revoking.id) : undefined)}
      />

      {secrets.loading ? (
        <ListSkeleton />
      ) : secrets.error ? (
        <LoadError title="Failed to load secrets" message={secrets.error.message} />
      ) : !secrets.data || secrets.data.length === 0 ? (
        <EmptyState
          icon={Lock}
          title="No secrets yet"
          description="Store provider keys and tokens encrypted at this scope; read them from your product at runtime."
          primaryAction={{ label: "New secret", onClick: () => setCreateOpen(true) }}
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead className="hidden md:table-cell">Status</TableHead>
                <TableHead className="hidden md:table-cell">Version</TableHead>
                <TableHead className="hidden md:table-cell">Last rotated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {secrets.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="font-mono text-xs">{s.secretKey}</div>
                    {s.displayName ? (
                      <div className="text-[11px] text-muted-foreground">{s.displayName}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <Badge variant={s.status === "active" ? "success" : "warning"}>{s.status}</Badge>
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs md:table-cell">v{s.version}</TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {s.lastRotatedAt ? new Date(s.lastRotatedAt).toLocaleDateString() : "never"}
                  </TableCell>
                  <TableCell className="space-x-1 text-right">
                    <Button size="sm" variant="ghost" onClick={() => setRotating(s)}>
                      Rotate
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRevoking(s)}>
                      Revoke
                    </Button>
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

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function ListSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-2 pt-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

function LoadError({ title, message }: { title: string; message: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-sm font-medium text-destructive">{title}</div>
        <div className="text-xs text-muted-foreground">{message}</div>
      </CardContent>
    </Card>
  );
}
