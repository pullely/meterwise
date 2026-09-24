// Integrations contracts — inbound provider integrations (GitHub App first).
// Owner: integrations-worker (apps/integrations-worker).
//
// Safe projections only: no installation tokens, no App credentials, no raw
// provider payloads. Raw inbound payloads stay in the integrations inbox
// (admin-worker visibility only); these shapes are what crosses the public
// API boundary and what `scm.*` events carry on the event log.
//
// Spec: specs/components/17-integrations.md, specs/epics/saas-integrations/.

// ── Provider seam ────────────────────────────────────────────

/**
 * Registry-driven provider identifier. GitHub is the first adapter, not a
 * special case; the type widens ("gitlab" | "bitbucket") as adapters land.
 */
export type IntegrationProviderId = "github";

// ── Connections ─────────────────────────────────────────────

export type IntegrationConnectionStatus =
  | "pending"
  | "active"
  | "suspended"
  | "revoked";

/**
 * Safe projection of an org ↔ provider connection (a GitHub App
 * installation bound to an organization). Never carries installation ids,
 * tokens, or state nonces.
 */
export interface PublicConnection {
  /** Public id, `int_<32hex>`. */
  id: string;
  /** Public org id, `org_<32hex>`. */
  orgId: string;
  provider: IntegrationProviderId;
  status: IntegrationConnectionStatus;
  /** Operator-facing label, defaults to the provider account login. */
  displayName: string | null;
  /** Provider-side account login (e.g. GitHub org login). */
  externalAccountLogin: string | null;
  /** Provider-side account kind, e.g. "Organization" | "User". */
  externalAccountType: string | null;
  /** Provider-side repo grant: "all" | "selected" (GitHub semantics). */
  repositorySelection: string | null;
  /** Opaque id of the actor that initiated the connect flow. */
  createdBy: string | null;
  /** ISO-8601; set when the provider-side install is verified and bound. */
  connectedAt: string | null;
  /** ISO-8601; set on platform-side revoke or provider-side uninstall. */
  revokedAt: string | null;
  suspendedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Repo links ──────────────────────────────────────────────

export type RepoLinkStatus = "active" | "unlinked";

/**
 * Branch → environment mapping, e.g. `{"main": "prod", "staging": "stage"}`.
 * Keys are provider branch names; values are environment slugs validated
 * against the project's live environments at write time.
 */
export type BranchEnvMap = Record<string, string>;

/** Safe projection of a project ↔ repository link. */
export interface PublicRepoLink {
  /** Public id, `repl_<32hex>`. */
  id: string;
  orgId: string;
  projectId: string;
  /** Owning connection public id (`int_<32hex>`). */
  connectionId: string;
  /** Provider-side repository id (opaque string; GitHub numeric id). */
  repoExternalId: string;
  /** Provider-side full name, e.g. "acme/storefront". */
  repoFullName: string;
  defaultBranch: string | null;
  branchEnvMap: BranchEnvMap;
  status: RepoLinkStatus;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Inbound deliveries ──────────────────────────────────────

export type InboundDeliveryStatus =
  | "received"
  | "attributed"
  | "emitted"
  | "skipped"
  | "failed";

/**
 * Safe projection of one inbound provider delivery (the durable-inbox row).
 * Never carries the raw payload — that stays in the inbox, admin-only.
 */
export interface PublicInboundDelivery {
  /** Public id, `igd_<32hex>`. */
  id: string;
  provider: IntegrationProviderId;
  /** Provider event type, e.g. "push", "pull_request", "installation". */
  eventType: string;
  /** Provider event action where applicable, e.g. "opened". */
  action: string | null;
  status: InboundDeliveryStatus;
  signatureOk: boolean;
  attempts: number;
  /** Safe failure summary; never raw provider error bodies. */
  failureReason: string | null;
  /** Event-log id of the emitted `scm.*` event, when status = "emitted". */
  emittedEventId: string | null;
  receivedAt: string;
}

// ── Cursor pagination (matches the platform list convention) ─

export interface IntegrationsCursor {
  createdAt: string;
  id: string;
}

// ── Connect flow ────────────────────────────────────────────

/**
 * POST /v1/organizations/{orgId}/integrations/{provider}/connect
 * Policy: organization.integration.connect.
 * Entitlement: feature.integrations.github.
 */
export interface ConnectIntegrationRequest {
  /** Optional operator label for the connection. */
  displayName?: string;
}

export interface ConnectIntegrationResponse {
  connection: PublicConnection;
  /**
   * Provider install URL carrying the signed single-use state. The console
   * opens this in a popup; the provider redirects back to the platform's
   * setup ingress which activates the connection.
   */
  installUrl: string;
}

/** GET /v1/organizations/{orgId}/integrations */
export interface ListIntegrationsResponse {
  connections: PublicConnection[];
  nextCursor: IntegrationsCursor | null;
}

/** GET /v1/organizations/{orgId}/integrations/{connectionId} */
export interface GetIntegrationResponse {
  connection: PublicConnection;
}

/** DELETE /v1/organizations/{orgId}/integrations/{connectionId} */
export interface RevokeIntegrationResponse {
  revoked: true;
}

// ── Repository browsing (IG3) ───────────────────────────────

/** Safe projection of a provider repository visible to an installation. */
export interface PublicRepository {
  /** Provider-side repository id (opaque string). */
  externalId: string;
  fullName: string;
  defaultBranch: string | null;
  private: boolean;
}

/**
 * GET /v1/organizations/{orgId}/integrations/{connectionId}/repositories
 * Lists repositories the installation can see (via the platform's cached
 * installation token). `query` filters by substring of the full name.
 */
export interface ListRepositoriesResponse {
  repositories: PublicRepository[];
  /** True when the provider reported more pages than were fetched. */
  truncated: boolean;
}

// ── Repo link flow ──────────────────────────────────────────

/**
 * POST /v1/organizations/{orgId}/projects/{projectId}/repo-links
 * Policy: project.repo_link.write. Entitlement: limit.repo_links.
 */
export interface CreateRepoLinkRequest {
  connectionId: string;
  repoExternalId: string;
  repoFullName: string;
  defaultBranch?: string;
  branchEnvMap?: BranchEnvMap;
}

export interface CreateRepoLinkResponse {
  repoLink: PublicRepoLink;
}

export interface UpdateRepoLinkRequest {
  branchEnvMap?: BranchEnvMap;
  defaultBranch?: string;
}

export interface UpdateRepoLinkResponse {
  repoLink: PublicRepoLink;
}

export interface ListRepoLinksResponse {
  repoLinks: PublicRepoLink[];
  nextCursor: IntegrationsCursor | null;
}

export interface DeleteRepoLinkResponse {
  deleted: true;
}

// ── Delivery log + replay ───────────────────────────────────

/** GET /v1/organizations/{orgId}/integrations/{connectionId}/deliveries */
export interface ListInboundDeliveriesResponse {
  deliveries: PublicInboundDelivery[];
  nextCursor: IntegrationsCursor | null;
}

/**
 * POST .../deliveries/{deliveryId}/replay — re-runs normalize/emit from the
 * persisted inbox row; never re-trusts the wire. Body reserved for future
 * options.
 */
export interface ReplayInboundDeliveryRequest {}

export interface ReplayInboundDeliveryResponse {
  delivery: PublicInboundDelivery;
}

// ── Token broker ────────────────────────────────────────────

/**
 * POST /v1/organizations/{orgId}/integrations/github/token
 * Policy: organization.integration.token.issue.
 *
 * Requested repositories must be linked to a project the actor can access;
 * requested permissions must be ⊆ the App's granted permissions
 * (deny-by-default). The minted token is returned exactly once, never
 * cached, never logged.
 */
export interface IssueIntegrationTokenRequest {
  /** Provider-side repository ids (must each match an active repo link). */
  repositories: string[];
  /** e.g. { "contents": "read", "checks": "write" }. */
  permissions: Record<string, "read" | "write">;
}

export interface IssueIntegrationTokenResponse {
  /** Reveal-once short-lived installation token. TTL ≤ 1h. */
  token: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
  repositories: string[];
  permissions: Record<string, "read" | "write">;
}

// ── Event taxonomy ──────────────────────────────────────────

/** Platform lifecycle events emitted by the integrations context. */
export const INTEGRATION_EVENT_TYPES = {
  CONNECTED: "integration.connected",
  SUSPENDED: "integration.suspended",
  REACTIVATED: "integration.reactivated",
  REVOKED: "integration.revoked",
  REPO_SELECTION_CHANGED: "integration.repo_selection_changed",
  TOKEN_ISSUED: "integration.token.issued",
} as const;

export type IntegrationEventType =
  (typeof INTEGRATION_EVENT_TYPES)[keyof typeof INTEGRATION_EVENT_TYPES];

/**
 * Normalized, provider-neutral SCM events emitted onto the event log.
 * Additive-only by rule (R7): new fields and new types may be added; existing
 * fields never change meaning. Products consume these through the shipped
 * outbound-webhooks pipeline.
 */
export const SCM_EVENT_TYPES = {
  PUSH: "scm.push",
  PULL_REQUEST_OPENED: "scm.pull_request.opened",
  PULL_REQUEST_UPDATED: "scm.pull_request.updated",
  PULL_REQUEST_MERGED: "scm.pull_request.merged",
  PULL_REQUEST_CLOSED: "scm.pull_request.closed",
  CHECK_COMPLETED: "scm.check.completed",
  RELEASE_PUBLISHED: "scm.release.published",
  BRANCH_CREATED: "scm.branch.created",
  BRANCH_DELETED: "scm.branch.deleted",
  TAG_CREATED: "scm.tag.created",
  REPO_LINKED: "scm.repo.linked",
  REPO_UNLINKED: "scm.repo.unlinked",
} as const;

export type ScmEventType = (typeof SCM_EVENT_TYPES)[keyof typeof SCM_EVENT_TYPES];

// ── Versioned `scm.*` payload projections (v1) ──────────────
// Compact, documented projections — never the raw provider payload (raw stays
// in the inbox for replay/debug). Every payload carries the repo identity and
// scope; `projectId`/`environment` are set when a repo link matches.

/** Repository identity carried by every scm.* payload. */
export interface ScmRepoRef {
  provider: IntegrationProviderId;
  externalId: string;
  fullName: string;
}

/** Common envelope-payload base for scm.* events (version 1). */
export interface ScmEventBaseV1 {
  version: 1;
  /** Public org id. */
  orgId: string;
  /** Public project id when a repo link matched, else null. */
  projectId: string | null;
  /** Environment slug resolved from the branch → environment map, else null. */
  environment: string | null;
  repo: ScmRepoRef;
}

export interface ScmPushEventV1 extends ScmEventBaseV1 {
  ref: string;
  branch: string | null;
  beforeSha: string;
  afterSha: string;
  /** Compact commit summaries; capped, never full diffs. */
  commits: Array<{
    sha: string;
    message: string;
    authorLogin: string | null;
  }>;
  pusherLogin: string | null;
}

export interface ScmPullRequestEventV1 extends ScmEventBaseV1 {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  authorLogin: string | null;
  url: string | null;
}

export interface ScmCheckCompletedEventV1 extends ScmEventBaseV1 {
  checkName: string;
  conclusion: string | null;
  headSha: string;
  url: string | null;
}

export interface ScmReleasePublishedEventV1 extends ScmEventBaseV1 {
  tagName: string;
  releaseName: string | null;
  url: string | null;
}

export interface ScmBranchEventV1 extends ScmEventBaseV1 {
  branch: string;
}

export interface ScmTagCreatedEventV1 extends ScmEventBaseV1 {
  tag: string;
}

export interface ScmRepoLinkEventV1 extends ScmEventBaseV1 {
  repoLinkId: string;
}

// ── Governance constants ────────────────────────────────────

/** Policy actions evaluated by policy-worker (deny-by-default). */
export const INTEGRATION_POLICY_ACTIONS = {
  READ: "organization.integration.read",
  CONNECT: "organization.integration.connect",
  MANAGE: "organization.integration.manage",
  TOKEN_ISSUE: "organization.integration.token.issue",
  REPO_LINK_WRITE: "project.repo_link.write",
} as const;

/** Entitlement keys gating the surface (412 + upgrade UX on deny). */
export const INTEGRATION_ENTITLEMENTS = {
  GITHUB: "feature.integrations.github",
  REPO_LINKS_LIMIT: "limit.repo_links",
} as const;
