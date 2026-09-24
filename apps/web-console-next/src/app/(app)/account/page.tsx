"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOut, User2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AccountTabs } from "@/components/account/account-tabs";
import { useQueryClient } from "@tanstack/react-query";
import { wrap } from "@/lib/api";
import { useApiQuery, qk } from "@/lib/query";
import { useSession } from "@/lib/session";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-guard";
import { useToast } from "@/components/ui/toast";
import {
  buildProfilePatch,
  validateDisplayName,
  initials,
  DISPLAY_NAME_MAX,
} from "@/components/account/profile";
import type { AuthUser } from "@saas/contracts/auth";

export default function AccountPage() {
  const { client, setToken } = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const qc = useQueryClient();

  // PERF11: profile is read through react-query so revisits paint instantly from
  // cache (stale-while-revalidate) instead of a manual uncached refetch.
  const profile = useApiQuery(qk.profile(), () =>
    wrap(async () => (await client.auth.getProfile()).user),
  );
  const user: AuthUser | null = profile.data;
  const loading = profile.loading;
  const error = profile.error?.message ?? null;
  const [name, setName] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // Seed the editable field from the (cached) profile. Keyed on the saved
  // displayName so a user's in-progress edit is never clobbered by a background
  // revalidation; a successful save updates the cache and re-seeds to the new value.
  React.useEffect(() => {
    if (user) setName(user.displayName ?? "");
  }, [user?.id, user?.displayName]);

  const nameValid = validateDisplayName(name);
  const dirty = user ? buildProfilePatch(user.displayName, name) !== null : false;
  useUnsavedChangesGuard(dirty && !saving);

  const save = async () => {
    if (!user || !nameValid.ok) return;
    const patch = buildProfilePatch(user.displayName, name);
    if (!patch) return;
    setSaving(true);
    const r = await wrap(() => client.auth.updateProfile(patch));
    setSaving(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Save failed", description: r.error.message });
      return;
    }
    // Write the saved user back to the shared cache (instant, no refetch); the
    // seed effect re-syncs `name` to the persisted displayName.
    qc.setQueryData(qk.profile(), r.data.user);
    toast({ kind: "success", title: "Profile updated" });
  };

  const signOut = async () => {
    // Best-effort server logout, then clear the local token regardless.
    await wrap(() => client.auth.logout());
    setToken(null);
    toast({ kind: "success", title: "Signed out" });
    router.push("/login");
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Account</h1>
        <p className="text-sm text-muted-foreground">Manage your profile and session.</p>
      </header>

      <AccountTabs active="profile" />

      {loading ? (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <Skeleton className="h-12 w-12 rounded-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-64" />
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">Failed to load profile</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : user ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Profile</CardTitle>
              <CardDescription>Your identity across every organization.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="grid h-12 w-12 place-items-center rounded-full bg-gradient-to-br from-primary to-primary/40 text-sm font-semibold text-primary-foreground">
                  {initials(user.displayName, user.email)}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{user.displayName ?? "—"}</div>
                  <div className="truncate text-xs text-muted-foreground">{user.email}</div>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" value={user.email} disabled />
                  <p className="text-[11px] text-muted-foreground">
                    Email changes aren&apos;t available from the console yet.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="displayName">Display name</Label>
                  <Input
                    id="displayName"
                    value={name}
                    maxLength={DISPLAY_NAME_MAX + 1}
                    placeholder="Your name"
                    onChange={(e) => setName(e.target.value)}
                  />
                  {!nameValid.ok ? (
                    <p className="text-[11px] text-destructive">{nameValid.message}</p>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  onClick={() => void save()}
                  loading={saving}
                  disabled={!dirty || !nameValid.ok}
                >
                  Save changes
                </Button>
                {dirty ? (
                  <Button
                    variant="ghost"
                    onClick={() => setName(user.displayName ?? "")}
                    disabled={saving}
                  >
                    Discard
                  </Button>
                ) : null}
              </div>

              <div className="border-t pt-3 text-[11px] font-mono text-muted-foreground">
                <User2 className="mr-1 inline h-3 w-3" />
                {user.id}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Session</CardTitle>
              <CardDescription>Sign out of the console on this device.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={() => void signOut()}>
                <LogOut className="mr-2 h-4 w-4" />
                Sign out
              </Button>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
