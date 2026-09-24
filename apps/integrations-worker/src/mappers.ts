import type { InboundDelivery, IntegrationConnection } from "@saas/db/integrations";
import type {
  PublicConnection,
  PublicInboundDelivery,
  IntegrationProviderId,
} from "@saas/contracts/integrations";
import { connectionPublicId, inboundDeliveryPublicId, orgPublicId } from "./ids.js";

function isoOrNull(d: Date | null): string | null {
  return d == null ? null : d.toISOString();
}

/**
 * Safe projection: no installation id, no state fields, no timestamps the
 * contract doesn't declare. The repo layer already excludes the nonce hash.
 */
export function toPublicConnection(connection: IntegrationConnection): PublicConnection {
  return {
    id: connectionPublicId(connection.id),
    orgId: orgPublicId(connection.orgId),
    provider: connection.provider as IntegrationProviderId,
    status: connection.status,
    displayName: connection.displayName,
    externalAccountLogin: connection.externalAccountLogin,
    externalAccountType: connection.externalAccountType,
    repositorySelection: null,
    createdBy: connection.createdBy,
    connectedAt: isoOrNull(connection.connectedAt),
    revokedAt: isoOrNull(connection.revokedAt),
    suspendedAt: isoOrNull(connection.suspendedAt),
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

/** Variant carrying the installation's repository selection when loaded. */
export function toPublicConnectionWithSelection(
  connection: IntegrationConnection,
  repositorySelection: string | null,
): PublicConnection {
  return { ...toPublicConnection(connection), repositorySelection };
}

/**
 * Safe projection of an inbox row: never the raw payload (admin-only) and
 * never the delivery key beyond what the provider already knows.
 */
export function toPublicInboundDelivery(delivery: InboundDelivery): PublicInboundDelivery {
  return {
    id: inboundDeliveryPublicId(delivery.id),
    provider: delivery.provider as IntegrationProviderId,
    eventType: delivery.eventType,
    action: delivery.action,
    status: delivery.status,
    signatureOk: delivery.signatureOk,
    attempts: delivery.attempts,
    failureReason: delivery.failureReason,
    emittedEventId: delivery.emittedEventId,
    receivedAt: delivery.receivedAt.toISOString(),
  };
}
