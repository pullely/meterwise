// `@saas/sdk` — Meterwise TypeScript SDK.
//
// Stable public surface:
//   - `Meterwise`              → the client class
//   - Per-resource clients reachable via `client.<resource>`
//   - typed error hierarchy from `./errors`
//   - request/response types re-exported from `@saas/contracts`
//
// The transport (`Transport`, `generateRequestId`) is exported for advanced
// callers (custom retry middleware, alt resource fan-out) but the typical
// integration path is the `Meterwise` class.

import { ApiKeysClient } from "./apiKeys.js";
import { AuthClient } from "./auth.js";
import { IntegrationsClient } from "./integrations.js";
import { BillingClient } from "./billing.js";
import { ConfigClient } from "./config.js";
import { EnvironmentsClient } from "./environments.js";
import { EventsClient } from "./events.js";
import { MembershipsClient } from "./memberships.js";
import { MeteringClient } from "./metering.js";
import { NotificationsClient } from "./notifications.js";
import { OrganizationsClient } from "./organizations.js";
import { ProjectsClient } from "./projects.js";
import { SecurityEventsClient } from "./securityEvents.js";
import { WebhooksClient } from "./webhooks.js";
import { Transport, type ClientOptions } from "./transport.js";

export class Meterwise {
  readonly organizations: OrganizationsClient;
  readonly projects: ProjectsClient;
  readonly environments: EnvironmentsClient;
  readonly memberships: MembershipsClient;
  readonly apiKeys: ApiKeysClient;
  readonly webhooks: WebhooksClient;
  readonly metering: MeteringClient;
  readonly billing: BillingClient;
  readonly events: EventsClient;
  readonly securityEvents: SecurityEventsClient;
  readonly config: ConfigClient;
  readonly notifications: NotificationsClient;
  readonly auth: AuthClient;
  readonly integrations: IntegrationsClient;
  /** Underlying HTTP transport. Exposed for advanced extension. */
  readonly transport: Transport;

  constructor(options: ClientOptions) {
    this.transport = new Transport(options);
    this.organizations = new OrganizationsClient(this.transport);
    this.projects = new ProjectsClient(this.transport);
    this.environments = new EnvironmentsClient(this.transport);
    this.memberships = new MembershipsClient(this.transport);
    this.apiKeys = new ApiKeysClient(this.transport);
    this.webhooks = new WebhooksClient(this.transport);
    this.metering = new MeteringClient(this.transport);
    this.billing = new BillingClient(this.transport);
    this.events = new EventsClient(this.transport);
    this.securityEvents = new SecurityEventsClient(this.transport);
    this.config = new ConfigClient(this.transport);
    this.notifications = new NotificationsClient(this.transport);
    this.auth = new AuthClient(this.transport);
    this.integrations = new IntegrationsClient(this.transport);
  }
}

// Resource clients (also reachable via `client.<resource>`).
export { OrganizationsClient } from "./organizations.js";
export { ProjectsClient } from "./projects.js";
export { EnvironmentsClient } from "./environments.js";
export { MembershipsClient } from "./memberships.js";
export {
  ApiKeysClient,
  type ListApiKeysResponse,
  type GetApiKeyResponse,
  type CreateApiKeyResponse,
  type RevokeApiKeyResponse,
} from "./apiKeys.js";
export {
  WebhooksClient,
  type ListDeliveryAttemptsQuery,
  type DeliveryAttemptsPage,
} from "./webhooks.js";
export { MeteringClient } from "./metering.js";
export { BillingClient } from "./billing.js";
export {
  EventsClient,
  AUDIT_ITERATOR_MAX_PAGES,
  type AuditEntryFilters,
  type ListAuditEntriesQuery,
  type ListAuditEntriesResult,
} from "./events.js";
export {
  SecurityEventsClient,
  type ListSecurityEventsQuery,
  type SecurityEventsPage,
} from "./securityEvents.js";
export { ConfigClient, type ConfigScope } from "./config.js";
export { NotificationsClient } from "./notifications.js";
export { AuthClient } from "./auth.js";
export { IntegrationsClient } from "./integrations.js";

// Transport surface.
export {
  Transport,
  generateRequestId,
  type AuthOption,
  type ClientOptions,
  type RequestOptions,
  type SuccessEnvelope,
} from "./transport.js";

// Typed error hierarchy.
export {
  MeterwiseError,
  BadRequestError,
  UnauthenticatedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  PreconditionFailedError,
  UnsupportedError,
  InternalError,
  RateLimitError,
  decodeError,
  type ErrorEnvelope,
  type RateLimitWindow,
} from "./errors.js";

// Re-export contract types so consumers don't import `@saas/contracts` directly.
export type {
  PublicOrganization,
  CreateOrganizationRequest,
  CreateOrganizationResponse,
  GetOrganizationResponse,
  ListOrganizationsResponse,
  PublicMember,
  PublicMemberRoleAssignment,
  ListMembersResponse,
  InvitationRole,
  CreateInvitationRequest,
  CreateInvitationResponse,
  PublicInvitation,
  ListInvitationsResponse,
  RevokeInvitationResponse,
  UpdateMemberRoleRequest,
  UpdateMemberRoleResponse,
  RemoveMemberResponse,
  AcceptInvitationRequest,
  AcceptInvitationResponse,
} from "@saas/contracts/membership";

export { ORGANIZATION_ROLES } from "@saas/contracts/membership";

export type {
  PublicProject,
  PublicEnvironment,
  CreateProjectRequest,
  CreateProjectResponse,
  GetProjectResponse,
  ListProjectsResponse,
  ArchiveProjectResponse,
  CreateEnvironmentRequest,
  CreateEnvironmentResponse,
  GetEnvironmentResponse,
  ListEnvironmentsResponse,
  ArchiveEnvironmentResponse,
} from "@saas/contracts/projects";

export type {
  PublicApiKey,
  PublicApiKeyServicePrincipal,
  PublicApiKeyCreateResult,
  PublicApiKeyRevokeResult,
  CreateApiKeyRequest,
} from "@saas/contracts/api-keys";

export type {
  PublicWebhookEndpoint,
  ListWebhookEndpointsResponse,
  GetWebhookEndpointResponse,
  CreateWebhookEndpointRequest,
  CreateWebhookEndpointResponse,
  UpdateWebhookEndpointRequest,
  UpdateWebhookEndpointResponse,
  EnableWebhookEndpointRequest,
  EnableWebhookEndpointResponse,
  DisableWebhookEndpointRequest,
  DisableWebhookEndpointResponse,
  DeleteWebhookEndpointResponse,
  RotateWebhookSecretResponse,
  PublicWebhookSubscription,
  ListWebhookSubscriptionsResponse,
  GetWebhookSubscriptionResponse,
  CreateWebhookSubscriptionRequest,
  CreateWebhookSubscriptionResponse,
  UpdateWebhookSubscriptionRequest,
  UpdateWebhookSubscriptionResponse,
  DeleteWebhookSubscriptionResponse,
  PublicWebhookDeliveryAttempt,
  ListWebhookDeliveryAttemptsResponse,
  GetWebhookDeliveryAttemptResponse,
  ReplayWebhookDeliveryRequest,
  ReplayWebhookDeliveryResponse,
} from "@saas/contracts/webhooks";

export type {
  RecordUsageRequest,
  RecordUsageResponse,
  PublicUsageRecord,
  IngestUsageBatchRequest,
  IngestUsageBatchResponse,
  GetUsageSummaryRequest,
  PublicUsageRollup,
  GetUsageSummaryResponse,
  CheckQuotaRequest,
  CheckQuotaResponse,
  ListQuotaViolationsRequest,
  PublicQuotaViolation,
  ListQuotaViolationsResponse,
} from "@saas/contracts/metering";

export type {
  PublicPlan,
  PublicPlanStatus,
  PublicBillingInterval,
  ListPlansRequest,
  ListPlansResponse,
  PublicBillingCustomer,
  PublicBillingCustomerStatus,
  GetBillingCustomerResponse,
  PublicSubscription,
  PublicSubscriptionStatus,
  PublicInvoice,
  PublicInvoiceStatus,
  ListInvoicesRequest,
  ListInvoicesResponse,
  PublicEntitlement,
  PublicEntitlementValueType,
  PublicEntitlementSource,
  GetEntitlementsRequest,
  GetEntitlementsResponse,
  GetBillingSummaryResponse,
} from "@saas/contracts/billing";

export type {
  PublicAuditEntry,
  ListAuditEntriesResponse,
  EventActorType,
} from "@saas/contracts/events";

export type {
  PublicSecurityEvent,
  SecurityEventListResponse,
} from "@saas/contracts/security-events";

export type {
  PublicSetting,
  ListSettingsResponse,
  CreateSettingRequest,
  UpdateSettingRequest,
  CreateSettingResponse,
  UpdateSettingResponse,
  PublicFeatureFlag,
  ListFeatureFlagsResponse,
  CreateFeatureFlagRequest,
  UpdateFeatureFlagRequest,
  CreateFeatureFlagResponse,
  UpdateFeatureFlagResponse,
  PublicSecretMetadata,
  ListSecretMetadataResponse,
  CreateSecretMetadataRequest,
  CreateSecretRequest,
  CreateSecretMetadataResponse,
  RotateSecretRequest,
  RotateSecretMetadataResponse,
  RevokeSecretMetadataResponse,
} from "@saas/contracts/config";

export type {
  NotificationChannel,
  NotificationCategory,
  NotificationStatus,
  NotificationSubjectKind,
  NotificationRecipient,
  EnqueueNotificationRequest,
  EnqueueNotificationResponse,
  GetNotificationResponse,
  NotificationDeliveryStatus,
  NotificationAttempt,
  NotificationCategoryPreferences,
  NotificationPreference,
  GetNotificationPreferencesQuery,
  GetNotificationPreferencesResponse,
  UpdateNotificationPreferencesRequest,
  UpdateNotificationPreferencesResponse,
  NotificationSuppressionReason,
  NotificationSuppression,
  SuppressRecipientRequest,
  SuppressRecipientResponse,
} from "@saas/contracts/notifications";

export { ERROR_CODES, type ErrorCode } from "@saas/contracts/errors";

export type {
  LoginStartRequest,
  LoginStartResponse,
  LoginCompleteRequest,
  LoginCompleteResponse,
  SessionResponse,
  LogoutResponse,
  ProfileResponse,
  UpdateProfileRequest,
  AuthUser,
} from "@saas/contracts/auth";
