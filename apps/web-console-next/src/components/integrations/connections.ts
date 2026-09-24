/**
 * Pure view-model helpers for the Integrations settings surface.
 * Dependency-free (no React) so the status/labels logic is unit-testable.
 */
import type {
  IntegrationConnectionStatus,
  PublicConnection,
} from "@saas/contracts/integrations";

export interface ConnectionStatusMeta {
  label: string;
  /** Badge tone consumed by the renderer. */
  tone: "default" | "success" | "warning" | "destructive";
}

export const CONNECTION_STATUS_META: Record<IntegrationConnectionStatus, ConnectionStatusMeta> = {
  pending: { label: "Pending", tone: "warning" },
  active: { label: "Active", tone: "success" },
  suspended: { label: "Suspended", tone: "warning" },
  revoked: { label: "Revoked", tone: "destructive" },
};

export function connectionStatusMeta(status: IntegrationConnectionStatus): ConnectionStatusMeta {
  return CONNECTION_STATUS_META[status] ?? { label: status, tone: "default" };
}

/** Display name for a connection row: label > account login > provider. */
export function connectionDisplayName(connection: PublicConnection): string {
  return (
    connection.displayName ??
    connection.externalAccountLogin ??
    "GitHub connection"
  );
}

/**
 * Rows worth showing in the settings list: everything except revoked rows
 * older than the newest revocation (history belongs to the audit log, but the
 * most recent revoked row stays visible so a revoke has an immediate,
 * confirmable result).
 */
export function visibleConnections(connections: PublicConnection[]): PublicConnection[] {
  const live = connections.filter((c) => c.status !== "revoked");
  const revoked = connections.filter((c) => c.status === "revoked");
  return revoked.length > 0 ? [...live, revoked[0]!] : live;
}

/** True while a connect popup flow should keep polling the list. */
export function hasPendingConnection(connections: PublicConnection[]): boolean {
  return connections.some((c) => c.status === "pending");
}
