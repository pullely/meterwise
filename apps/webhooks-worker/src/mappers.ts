import type { WebhookEndpoint, WebhookSubscription, WebhookDeliveryAttempt } from "@saas/db/webhooks";
import type { PublicWebhookEndpoint, PublicWebhookSubscription, PublicWebhookDeliveryAttempt } from "@saas/contracts/webhooks";
import {
  orgPublicId,
  webhookEndpointPublicId,
  webhookSubscriptionPublicId,
  webhookDeliveryAttemptPublicId,
  projectPublicId,
} from "./ids.js";

function toISOString(d: Date): string {
  return d.toISOString();
}

export function toPublicWebhookEndpoint(e: WebhookEndpoint): PublicWebhookEndpoint {
  return {
    id: webhookEndpointPublicId(e.id),
    orgId: orgPublicId(e.orgId),
    projectId: e.projectId ? projectPublicId(e.projectId) : null,
    url: e.url,
    name: e.name,
    description: e.description,
    status: e.status,
    disabledReason: e.disabledReason,
    disabledAt: e.disabledAt ? toISOString(e.disabledAt) : null,
    secretVersion: e.secretVersion,
    secretLastRotatedAt: e.secretLastRotatedAt ? toISOString(e.secretLastRotatedAt) : null,
    createdAt: toISOString(e.createdAt),
    updatedAt: toISOString(e.updatedAt),
  };
}

export function toPublicWebhookSubscription(s: WebhookSubscription): PublicWebhookSubscription {
  return {
    id: webhookSubscriptionPublicId(s.id),
    orgId: orgPublicId(s.orgId),
    endpointId: webhookEndpointPublicId(s.endpointId),
    projectId: s.projectId ? projectPublicId(s.projectId) : null,
    eventType: s.eventType,
    enabled: s.enabled,
    createdAt: toISOString(s.createdAt),
    updatedAt: toISOString(s.updatedAt),
  };
}

export function toPublicDeliveryAttempt(d: WebhookDeliveryAttempt): PublicWebhookDeliveryAttempt {
  return {
    id: webhookDeliveryAttemptPublicId(d.id),
    orgId: orgPublicId(d.orgId),
    endpointId: webhookEndpointPublicId(d.endpointId),
    subscriptionId: webhookSubscriptionPublicId(d.subscriptionId),
    eventId: d.eventId,
    eventType: d.eventType,
    status: d.status,
    attemptNumber: d.attemptNumber,
    httpStatusCode: d.httpStatusCode,
    failureReason: d.failureReason,
    idempotencyKey: d.idempotencyKey,
    nextRetryAt: d.nextRetryAt ? toISOString(d.nextRetryAt) : null,
    completedAt: d.completedAt ? toISOString(d.completedAt) : null,
    createdAt: toISOString(d.createdAt),
    updatedAt: toISOString(d.updatedAt),
  };
}
