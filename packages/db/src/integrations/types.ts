import type { Uuid } from "../ids/index.js";

export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../d1/executor.js";

// ── Result type ─────────────────────────────────────────────

export type IntegrationsRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type IntegrationsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: IntegrationsRepositoryError };

// ── Cursor pagination (matches existing convention) ─────────

export interface CursorPosition {
  createdAt: string;
  id: string;
}

export interface PageQueryParams {
  limit: number;
  cursor: CursorPosition | null;
}

export interface PagedResult<T> {
  items: T[];
  nextCursor: CursorPosition | null;
}

// ── Connections ─────────────────────────────────────────────
// NOTE: state_nonce_hash is write/lookup-only — it is intentionally excluded
// from the read model so it can never leak through a list/read surface.

export type ConnectionStatus = "pending" | "active" | "suspended" | "revoked";

export interface IntegrationConnection {
  id: string;
  orgId: string;
  provider: string;
  status: ConnectionStatus;
  displayName: string | null;
  externalAccountLogin: string | null;
  externalAccountId: string | null;
  externalAccountType: string | null;
  createdBy: string | null;
  stateExpiresAt: Date | null;
  connectedAt: Date | null;
  suspendedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateConnectionInput {
  id: string;
  orgId: Uuid;
  provider: string;
  displayName?: string | null;
  createdBy?: string | null;
  /** SHA-256 hex of the single-use signed-state nonce (write-only). */
  stateNonceHash?: string | null;
  stateExpiresAt?: Date | null;
}

export interface ActivateConnectionInput {
  displayName?: string | null;
  externalAccountLogin?: string | null;
  externalAccountId?: string | null;
  externalAccountType?: string | null;
}

export interface ListConnectionsQuery {
  provider?: string;
  status?: ConnectionStatus;
}

// ── GitHub installations ────────────────────────────────────

export interface GithubInstallation {
  id: string;
  /** Null = orphaned installation (recorded, never auto-bound). */
  connectionId: string | null;
  installationId: number;
  accountLogin: string | null;
  accountId: number | null;
  accountType: string | null;
  repositorySelection: string | null;
  permissions: Record<string, unknown> | null;
  events: unknown[] | null;
  suspendedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertGithubInstallationInput {
  id: string;
  connectionId?: Uuid | null;
  installationId: number;
  accountLogin?: string | null;
  accountId?: number | null;
  accountType?: string | null;
  repositorySelection?: string | null;
  permissions?: Record<string, unknown> | null;
  events?: unknown[] | null;
  suspendedAt?: Date | null;
}

// ── Repo links ──────────────────────────────────────────────

export type RepoLinkStatus = "active" | "unlinked";

export interface RepoLink {
  id: string;
  orgId: string;
  projectId: string;
  connectionId: string;
  repoExternalId: string;
  repoFullName: string;
  defaultBranch: string | null;
  branchEnvMap: Record<string, string>;
  status: RepoLinkStatus;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRepoLinkInput {
  id: string;
  orgId: Uuid;
  projectId: Uuid;
  connectionId: Uuid;
  repoExternalId: string;
  repoFullName: string;
  defaultBranch?: string | null;
  branchEnvMap?: Record<string, string>;
  createdBy?: string | null;
}

export interface UpdateRepoLinkInput {
  defaultBranch?: string | null;
  branchEnvMap?: Record<string, string>;
}

export interface ListRepoLinksQuery {
  projectId?: Uuid;
  status?: RepoLinkStatus;
}

// ── Inbound deliveries ──────────────────────────────────────

export type InboundDeliveryStatus =
  | "received"
  | "attributed"
  | "emitted"
  | "skipped"
  | "failed";

export interface InboundDelivery {
  id: string;
  orgId: string | null;
  /** Owning connection once attributed (installation → connection → org). */
  connectionId: string | null;
  provider: string;
  deliveryKey: string;
  eventType: string;
  action: string | null;
  /** Raw provider payload — admin-only; never exposed through public APIs. */
  payload: Record<string, unknown>;
  signatureOk: boolean;
  status: InboundDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  failureReason: string | null;
  emittedEventId: string | null;
  receivedAt: Date;
  updatedAt: Date;
}

export interface InsertInboundDeliveryInput {
  id: string;
  provider: string;
  deliveryKey: string;
  eventType: string;
  action?: string | null;
  payload: Record<string, unknown>;
  signatureOk: boolean;
}

/** Result of an idempotent inbox insert: created=false on a redelivery. */
export interface InsertInboundDeliveryOutcome {
  delivery: InboundDelivery;
  created: boolean;
}

export interface MarkInboundDeliveryInput {
  orgId?: Uuid | null;
  connectionId?: Uuid | null;
  status?: InboundDeliveryStatus;
  attempts?: number;
  nextAttemptAt?: Date | null;
  failureReason?: string | null;
  emittedEventId?: Uuid | null;
}

// ── Installation token cache ────────────────────────────────
// Serves only the platform's own provider calls. The ciphertext is returned
// by the repository (the worker must decrypt) but must never cross a public
// API surface or appear in logs.

export interface InstallationTokenCacheEntry {
  id: string;
  connectionId: string;
  tokenCiphertext: string;
  permissions: Record<string, unknown> | null;
  repositoryIds: unknown[] | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertInstallationTokenInput {
  id: string;
  connectionId: Uuid;
  tokenCiphertext: string;
  permissions?: Record<string, unknown> | null;
  repositoryIds?: unknown[] | null;
  expiresAt: Date;
}

// ── Repository interface ────────────────────────────────────

export interface IntegrationsRepository {
  // Connections
  createConnection(input: CreateConnectionInput): Promise<IntegrationsResult<IntegrationConnection>>;
  getConnection(orgId: Uuid, id: Uuid): Promise<IntegrationsResult<IntegrationConnection>>;
  /**
   * INTERNAL (drain/replay only): resolve a connection without an org filter.
   * The inbound pipeline attributes deliveries installation → connection →
   * org, so the org is an output here, not an input. Never expose through a
   * request-scoped read path.
   */
  getConnectionById(id: Uuid): Promise<IntegrationsResult<IntegrationConnection>>;
  listConnections(
    orgId: Uuid,
    params: PageQueryParams,
    query?: ListConnectionsQuery,
  ): Promise<IntegrationsResult<PagedResult<IntegrationConnection>>>;
  /**
   * Resolve the pending connection for a connect-flow callback and consume
   * its nonce atomically (single-use). Fails closed: expired or already-
   * consumed state resolves to not_found.
   */
  consumeConnectionState(stateNonceHash: string): Promise<IntegrationsResult<IntegrationConnection>>;
  /** Activate a pending connection with verified provider account facts. */
  activateConnection(
    orgId: Uuid,
    id: Uuid,
    input: ActivateConnectionInput,
  ): Promise<IntegrationsResult<IntegrationConnection>>;
  updateConnectionStatus(
    orgId: Uuid,
    id: Uuid,
    status: ConnectionStatus,
  ): Promise<IntegrationsResult<IntegrationConnection>>;

  // GitHub installations
  upsertGithubInstallation(
    input: UpsertGithubInstallationInput,
  ): Promise<IntegrationsResult<GithubInstallation>>;
  getGithubInstallationByInstallationId(
    installationId: number,
  ): Promise<IntegrationsResult<GithubInstallation>>;
  getGithubInstallationByConnectionId(
    connectionId: Uuid,
  ): Promise<IntegrationsResult<GithubInstallation>>;

  // Repo links
  createRepoLink(input: CreateRepoLinkInput): Promise<IntegrationsResult<RepoLink>>;
  getRepoLink(orgId: Uuid, id: Uuid): Promise<IntegrationsResult<RepoLink>>;
  listRepoLinks(
    orgId: Uuid,
    params: PageQueryParams,
    query?: ListRepoLinksQuery,
  ): Promise<IntegrationsResult<PagedResult<RepoLink>>>;
  updateRepoLink(
    orgId: Uuid,
    id: Uuid,
    input: UpdateRepoLinkInput,
  ): Promise<IntegrationsResult<RepoLink>>;
  /** Soft-unlink: flips status to 'unlinked'; the row remains for audit. */
  unlinkRepoLink(orgId: Uuid, id: Uuid): Promise<IntegrationsResult<RepoLink>>;
  /** Drain enrichment: active links matching a provider repo, org-scoped. */
  listActiveRepoLinksForRepo(
    orgId: Uuid,
    repoExternalId: string,
  ): Promise<IntegrationsResult<RepoLink[]>>;
  /** Entitlement gating: count of active links in the organization. */
  countActiveRepoLinks(orgId: Uuid): Promise<IntegrationsResult<number>>;

  // Inbound deliveries (durable inbox)
  insertInboundDelivery(
    input: InsertInboundDeliveryInput,
  ): Promise<IntegrationsResult<InsertInboundDeliveryOutcome>>;
  getInboundDelivery(id: Uuid): Promise<IntegrationsResult<InboundDelivery>>;
  listInboundDeliveries(
    orgId: Uuid,
    params: PageQueryParams,
    query?: { connectionId?: Uuid },
  ): Promise<IntegrationsResult<PagedResult<InboundDelivery>>>;
  /** Cron drain scan: due pending work, oldest first. */
  listDueInboundDeliveries(limit: number): Promise<IntegrationsResult<InboundDelivery[]>>;
  markInboundDelivery(
    id: Uuid,
    input: MarkInboundDeliveryInput,
  ): Promise<IntegrationsResult<InboundDelivery>>;

  // Installation token cache
  upsertInstallationToken(
    input: UpsertInstallationTokenInput,
  ): Promise<IntegrationsResult<InstallationTokenCacheEntry>>;
  getInstallationToken(
    connectionId: Uuid,
  ): Promise<IntegrationsResult<InstallationTokenCacheEntry>>;
  deleteInstallationToken(connectionId: Uuid): Promise<IntegrationsResult<{ deleted: true }>>;
}
