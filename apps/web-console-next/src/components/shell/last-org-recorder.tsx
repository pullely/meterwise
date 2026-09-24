"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { useSession } from "@/lib/session";
import { readLastOrgSlug, writeLastOrgSlug } from "@/lib/last-org";

/**
 * Invisible recorder/sync for the last-used org. Mounted once in the app shell.
 *
 * - Records the current org slug to the local cache (instant) and to the server
 *   profile (best-effort, once per slug) so the default follows the user across
 *   devices.
 * - Reconciles on mount: if this device has no local hint yet, seed it from the
 *   server preference (covers a fresh browser/device for an already-signed-in
 *   user). A non-empty local value is left as the authoritative recent activity
 *   for this device.
 */
export function LastOrgRecorder() {
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? null;
  const { client, token } = useSession();
  const sentRef = React.useRef<string | null>(null);

  // Reconcile once per session: seed the local cache from the server when empty.
  React.useEffect(() => {
    if (!token || readLastOrgSlug()) return;
    let cancelled = false;
    client.auth
      .getProfile()
      .then((r) => {
        if (!cancelled && !readLastOrgSlug() && r.user.lastOrgSlug) {
          writeLastOrgSlug(r.user.lastOrgSlug);
        }
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      cancelled = true;
    };
  }, [client, token]);

  // Record on org visit: local cache (instant) + server (best-effort, deduped).
  React.useEffect(() => {
    if (!orgSlug) return;
    writeLastOrgSlug(orgSlug);
    if (sentRef.current === orgSlug) return;
    sentRef.current = orgSlug;
    client.auth.updateProfile({ lastOrgSlug: orgSlug }).catch(() => {
      // API-key tokens / offline — the local cache still works; reset so a later
      // navigation back to this org retries the server write.
      if (sentRef.current === orgSlug) sentRef.current = null;
    });
  }, [orgSlug, client]);

  return null;
}
