import type { SqlExecutor } from "../d1/executor.js";
import type { Uuid } from "../ids/index.js";
import type {
  ActivateConnectionInput,
  ConnectionStatus,
  CreateConnectionInput,
  CreateRepoLinkInput,
  CursorPosition,
  GithubInstallation,
  InboundDelivery,
  InsertInboundDeliveryInput,
  InsertInboundDeliveryOutcome,
  InstallationTokenCacheEntry,
  IntegrationConnection,
  IntegrationsRepository,
  IntegrationsResult,
  ListConnectionsQuery,
  ListRepoLinksQuery,
  MarkInboundDeliveryInput,
  PagedResult,
  PageQueryParams,
  RepoLink,
  UpdateRepoLinkInput,
  UpsertGithubInstallationInput,
  UpsertInstallationTokenInput,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";
import { parseBooleanColumn } from "../json.js";

// ── Helpers ─────────────────────────────────────────────────

function safeError(message: string): IntegrationsResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}


function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}

function dateOrNull(v: unknown): Date | null {
  return v == null ? null : toDate(v);
}

function isoOrNull(v: Date | null | undefined): string | null {
  return v == null ? null : v.toISOString();
}

function jsonOrNull(v: unknown): string | null {
  return v == null ? null : JSON.stringify(v);
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v as T;
}

// ── Row mappers ─────────────────────────────────────────────

function mapConnection(row: Record<string, unknown>): IntegrationConnection {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    provider: row.provider as string,
    status: row.status as ConnectionStatus,
    displayName: (row.display_name as string) ?? null,
    externalAccountLogin: (row.external_account_login as string) ?? null,
    externalAccountId: (row.external_account_id as string) ?? null,
    externalAccountType: (row.external_account_type as string) ?? null,
    createdBy: (row.created_by as string) ?? null,
    stateExpiresAt: dateOrNull(row.state_expires_at),
    connectedAt: dateOrNull(row.connected_at),
    suspendedAt: dateOrNull(row.suspended_at),
    revokedAt: dateOrNull(row.revoked_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapGithubInstallation(row: Record<string, unknown>): GithubInstallation {
  return {
    id: row.id as string,
    connectionId: (row.connection_id as string) ?? null,
    installationId: Number(row.installation_id),
    accountLogin: (row.account_login as string) ?? null,
    accountId: row.account_id == null ? null : Number(row.account_id),
    accountType: (row.account_type as string) ?? null,
    repositorySelection: (row.repository_selection as string) ?? null,
    permissions: parseJson<Record<string, unknown>>(row.permissions),
    events: parseJson<unknown[]>(row.events),
    suspendedAt: dateOrNull(row.suspended_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapRepoLink(row: Record<string, unknown>): RepoLink {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: row.project_id as string,
    connectionId: row.connection_id as string,
    repoExternalId: row.repo_external_id as string,
    repoFullName: row.repo_full_name as string,
    defaultBranch: (row.default_branch as string) ?? null,
    branchEnvMap: parseJson<Record<string, string>>(row.branch_env_map) ?? {},
    status: row.status as RepoLink["status"],
    createdBy: (row.created_by as string) ?? null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapInboundDelivery(row: Record<string, unknown>): InboundDelivery {
  return {
    id: row.id as string,
    orgId: (row.org_id as string) ?? null,
    connectionId: (row.connection_id as string) ?? null,
    provider: row.provider as string,
    deliveryKey: row.delivery_key as string,
    eventType: row.event_type as string,
    action: (row.action as string) ?? null,
    payload: parseJson<Record<string, unknown>>(row.payload) ?? {},
    signatureOk: parseBooleanColumn(row.signature_ok),
    status: row.status as InboundDelivery["status"],
    attempts: Number(row.attempts),
    nextAttemptAt: dateOrNull(row.next_attempt_at),
    failureReason: (row.failure_reason as string) ?? null,
    emittedEventId: (row.emitted_event_id as string) ?? null,
    receivedAt: toDate(row.received_at),
    updatedAt: toDate(row.updated_at),
  };
}

function mapInstallationToken(row: Record<string, unknown>): InstallationTokenCacheEntry {
  return {
    id: row.id as string,
    connectionId: row.connection_id as string,
    tokenCiphertext: row.token_ciphertext as string,
    permissions: parseJson<Record<string, unknown>>(row.permissions),
    repositoryIds: parseJson<unknown[]>(row.repository_ids),
    expiresAt: toDate(row.expires_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

// ── Cursor pagination helper ────────────────────────────────

async function pagedList<T>(
  executor: SqlExecutor,
  sql: string,
  values: unknown[],
  limit: number,
  cursor: CursorPosition | null,
  mapper: (row: Record<string, unknown>) => T,
  cursorDateField = "created_at",
): Promise<IntegrationsResult<PagedResult<T>>> {
  try {
    const fetchLimit = limit + 1;
    let fullSql: string;
    let fullValues: unknown[];
    const baseIdx = values.length;

    if (cursor) {
      fullSql = `${sql} AND (${cursorDateField}, id) < ($${baseIdx + 2}, $${baseIdx + 3}) ORDER BY ${cursorDateField} DESC, id DESC LIMIT $${baseIdx + 1}`;
      fullValues = [...values, fetchLimit, cursor.createdAt, cursor.id];
    } else {
      fullSql = `${sql} ORDER BY ${cursorDateField} DESC, id DESC LIMIT $${baseIdx + 1}`;
      fullValues = [...values, fetchLimit];
    }

    const result = await executor.execute<Record<string, unknown>>(fullSql, fullValues);
    const rows = result.rows.map(mapper);
    let nextCursor: CursorPosition | null = null;
    if (rows.length > limit) {
      rows.pop();
      const last = rows[rows.length - 1]!;
      nextCursor = {
        createdAt: (last as unknown as { createdAt: Date }).createdAt.toISOString(),
        id: (last as unknown as { id: string }).id,
      };
    }
    return { ok: true, value: { items: rows, nextCursor } };
  } catch {
    return safeError("Failed to list records");
  }
}

// ── Repository factory ──────────────────────────────────────

export function createIntegrationsRepository(executor: SqlExecutor): IntegrationsRepository {
  return {
    // ── Connections ─────────────────────────────────────────

    async createConnection(
      input: CreateConnectionInput,
    ): Promise<IntegrationsResult<IntegrationConnection>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO integrations_connections
             (id, org_id, provider, status, display_name, created_by,
              state_nonce_hash, state_expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.provider,
            input.displayName ?? null,
            input.createdBy ?? null,
            input.stateNonceHash ?? null,
            isoOrNull(input.stateExpiresAt),
          ],
        );
        return { ok: true, value: mapConnection(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "connection" } };
        }
        return safeError("Failed to create connection");
      }
    },

    async getConnection(
      orgId: Uuid,
      id: Uuid,
    ): Promise<IntegrationsResult<IntegrationConnection>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM integrations_connections WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapConnection(result.rows[0]!) };
      } catch {
        return safeError("Failed to get connection");
      }
    },

    async getConnectionById(id: Uuid): Promise<IntegrationsResult<IntegrationConnection>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM integrations_connections WHERE id = $1`,
          [id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapConnection(result.rows[0]!) };
      } catch {
        return safeError("Failed to get connection");
      }
    },

    async listConnections(
      orgId: Uuid,
      params: PageQueryParams,
      query?: ListConnectionsQuery,
    ): Promise<IntegrationsResult<PagedResult<IntegrationConnection>>> {
      const values: unknown[] = [orgId];
      let sql = `SELECT * FROM integrations_connections WHERE org_id = $1`;
      if (query?.provider) {
        values.push(query.provider);
        sql += ` AND provider = $${values.length}`;
      }
      if (query?.status) {
        values.push(query.status);
        sql += ` AND status = $${values.length}`;
      }
      return pagedList(executor, sql, values, params.limit, params.cursor, mapConnection);
    },

    async consumeConnectionState(
      stateNonceHash: string,
    ): Promise<IntegrationsResult<IntegrationConnection>> {
      try {
        // Single-use: the nonce is cleared in the same statement that
        // resolves it, and expired state never matches. Fail closed.
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE integrations_connections
              SET state_nonce_hash = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE state_nonce_hash = $1
              AND status = 'pending'
              AND state_expires_at IS NOT NULL
              AND state_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
            RETURNING *`,
          [stateNonceHash],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapConnection(result.rows[0]!) };
      } catch {
        return safeError("Failed to consume connection state");
      }
    },

    async activateConnection(
      orgId: Uuid,
      id: Uuid,
      input: ActivateConnectionInput,
    ): Promise<IntegrationsResult<IntegrationConnection>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE integrations_connections
              SET status = 'active',
                  display_name = COALESCE($3, display_name),
                  external_account_login = $4,
                  external_account_id = $5,
                  external_account_type = $6,
                  state_nonce_hash = NULL,
                  state_expires_at = NULL,
                  connected_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE org_id = $1 AND id = $2 AND status = 'pending'
            RETURNING *`,
          [
            orgId,
            id,
            input.displayName ?? null,
            input.externalAccountLogin ?? null,
            input.externalAccountId ?? null,
            input.externalAccountType ?? null,
          ],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapConnection(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "connection" } };
        }
        return safeError("Failed to activate connection");
      }
    },

    async updateConnectionStatus(
      orgId: Uuid,
      id: Uuid,
      status: ConnectionStatus,
    ): Promise<IntegrationsResult<IntegrationConnection>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE integrations_connections
              SET status = $3,
                  suspended_at = CASE WHEN $3 = 'suspended' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE suspended_at END,
                  revoked_at   = CASE WHEN $3 = 'revoked' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE revoked_at END,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE org_id = $1 AND id = $2
            RETURNING *`,
          [orgId, id, status],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapConnection(result.rows[0]!) };
      } catch {
        return safeError("Failed to update connection status");
      }
    },

    // ── GitHub installations ────────────────────────────────

    async upsertGithubInstallation(
      input: UpsertGithubInstallationInput,
    ): Promise<IntegrationsResult<GithubInstallation>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO integrations_github_installations
             (id, connection_id, installation_id, account_login, account_id,
              account_type, repository_selection, permissions, events,
              suspended_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (installation_id) DO UPDATE SET
             connection_id = COALESCE(EXCLUDED.connection_id, integrations_github_installations.connection_id),
             account_login = EXCLUDED.account_login,
             account_id = EXCLUDED.account_id,
             account_type = EXCLUDED.account_type,
             repository_selection = EXCLUDED.repository_selection,
             permissions = EXCLUDED.permissions,
             events = EXCLUDED.events,
             suspended_at = EXCLUDED.suspended_at,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           RETURNING *`,
          [
            input.id,
            input.connectionId ?? null,
            input.installationId,
            input.accountLogin ?? null,
            input.accountId ?? null,
            input.accountType ?? null,
            input.repositorySelection ?? null,
            jsonOrNull(input.permissions),
            jsonOrNull(input.events),
            isoOrNull(input.suspendedAt),
          ],
        );
        return { ok: true, value: mapGithubInstallation(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "github_installation" } };
        }
        return safeError("Failed to upsert GitHub installation");
      }
    },

    async getGithubInstallationByInstallationId(
      installationId: number,
    ): Promise<IntegrationsResult<GithubInstallation>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM integrations_github_installations WHERE installation_id = $1`,
          [installationId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapGithubInstallation(result.rows[0]!) };
      } catch {
        return safeError("Failed to get GitHub installation");
      }
    },

    async getGithubInstallationByConnectionId(
      connectionId: Uuid,
    ): Promise<IntegrationsResult<GithubInstallation>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM integrations_github_installations WHERE connection_id = $1`,
          [connectionId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapGithubInstallation(result.rows[0]!) };
      } catch {
        return safeError("Failed to get GitHub installation");
      }
    },

    // ── Repo links ──────────────────────────────────────────

    async createRepoLink(input: CreateRepoLinkInput): Promise<IntegrationsResult<RepoLink>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO integrations_repo_links
             (id, org_id, project_id, connection_id, repo_external_id,
              repo_full_name, default_branch, branch_env_map, status,
              created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           RETURNING *`,
          [
            input.id,
            input.orgId,
            input.projectId,
            input.connectionId,
            input.repoExternalId,
            input.repoFullName,
            input.defaultBranch ?? null,
            JSON.stringify(input.branchEnvMap ?? {}),
            input.createdBy ?? null,
          ],
        );
        return { ok: true, value: mapRepoLink(result.rows[0]!) };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "repo_link" } };
        }
        return safeError("Failed to create repo link");
      }
    },

    async getRepoLink(orgId: Uuid, id: Uuid): Promise<IntegrationsResult<RepoLink>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM integrations_repo_links WHERE org_id = $1 AND id = $2`,
          [orgId, id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRepoLink(result.rows[0]!) };
      } catch {
        return safeError("Failed to get repo link");
      }
    },

    async listRepoLinks(
      orgId: Uuid,
      params: PageQueryParams,
      query?: ListRepoLinksQuery,
    ): Promise<IntegrationsResult<PagedResult<RepoLink>>> {
      const values: unknown[] = [orgId];
      let sql = `SELECT * FROM integrations_repo_links WHERE org_id = $1`;
      if (query?.projectId) {
        values.push(query.projectId);
        sql += ` AND project_id = $${values.length}`;
      }
      if (query?.status) {
        values.push(query.status);
        sql += ` AND status = $${values.length}`;
      }
      return pagedList(executor, sql, values, params.limit, params.cursor, mapRepoLink);
    },

    async updateRepoLink(
      orgId: Uuid,
      id: Uuid,
      input: UpdateRepoLinkInput,
    ): Promise<IntegrationsResult<RepoLink>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE integrations_repo_links
              SET default_branch = COALESCE($3, default_branch),
                  branch_env_map = COALESCE($4, branch_env_map),
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE org_id = $1 AND id = $2 AND status = 'active'
            RETURNING *`,
          [
            orgId,
            id,
            input.defaultBranch ?? null,
            input.branchEnvMap == null ? null : JSON.stringify(input.branchEnvMap),
          ],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRepoLink(result.rows[0]!) };
      } catch {
        return safeError("Failed to update repo link");
      }
    },

    async unlinkRepoLink(orgId: Uuid, id: Uuid): Promise<IntegrationsResult<RepoLink>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE integrations_repo_links
              SET status = 'unlinked', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE org_id = $1 AND id = $2 AND status = 'active'
            RETURNING *`,
          [orgId, id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapRepoLink(result.rows[0]!) };
      } catch {
        return safeError("Failed to unlink repo link");
      }
    },

    async listActiveRepoLinksForRepo(
      orgId: Uuid,
      repoExternalId: string,
    ): Promise<IntegrationsResult<RepoLink[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM integrations_repo_links
            WHERE org_id = $1 AND repo_external_id = $2 AND status = 'active'
            ORDER BY created_at ASC, id ASC`,
          [orgId, repoExternalId],
        );
        return { ok: true, value: result.rows.map(mapRepoLink) };
      } catch {
        return safeError("Failed to list repo links for repo");
      }
    },

    async countActiveRepoLinks(orgId: Uuid): Promise<IntegrationsResult<number>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT COUNT(*) AS count FROM integrations_repo_links
            WHERE org_id = $1 AND status = 'active'`,
          [orgId],
        );
        return { ok: true, value: Number(result.rows[0]?.count ?? 0) };
      } catch {
        return safeError("Failed to count repo links");
      }
    },

    // ── Inbound deliveries ──────────────────────────────────

    async insertInboundDelivery(
      input: InsertInboundDeliveryInput,
    ): Promise<IntegrationsResult<InsertInboundDeliveryOutcome>> {
      try {
        // Idempotent inbox insert: a redelivery (same provider delivery key)
        // is a no-op that returns the existing row with created=false.
        const inserted = await executor.execute<Record<string, unknown>>(
          `INSERT INTO integrations_inbound_deliveries
             (id, provider, delivery_key, event_type, action, payload,
              signature_ok, status, received_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'received', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (provider, delivery_key) DO NOTHING
           RETURNING *`,
          [
            input.id,
            input.provider,
            input.deliveryKey,
            input.eventType,
            input.action ?? null,
            JSON.stringify(input.payload),
            input.signatureOk,
          ],
        );
        if (inserted.rowCount > 0) {
          return {
            ok: true,
            value: { delivery: mapInboundDelivery(inserted.rows[0]!), created: true },
          };
        }
        const existing = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM integrations_inbound_deliveries
            WHERE provider = $1 AND delivery_key = $2`,
          [input.provider, input.deliveryKey],
        );
        if (existing.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return {
          ok: true,
          value: { delivery: mapInboundDelivery(existing.rows[0]!), created: false },
        };
      } catch {
        return safeError("Failed to insert inbound delivery");
      }
    },

    async getInboundDelivery(id: Uuid): Promise<IntegrationsResult<InboundDelivery>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM integrations_inbound_deliveries WHERE id = $1`,
          [id],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapInboundDelivery(result.rows[0]!) };
      } catch {
        return safeError("Failed to get inbound delivery");
      }
    },

    async listInboundDeliveries(
      orgId: Uuid,
      params: PageQueryParams,
      query?: { connectionId?: Uuid },
    ): Promise<IntegrationsResult<PagedResult<InboundDelivery>>> {
      const values: unknown[] = [orgId];
      let sql = `SELECT * FROM integrations_inbound_deliveries WHERE org_id = $1`;
      if (query?.connectionId) {
        values.push(query.connectionId);
        sql += ` AND connection_id = $${values.length}`;
      }
      return pagedList(
        executor,
        sql,
        values,
        params.limit,
        params.cursor,
        mapInboundDelivery,
        "received_at",
      );
    },

    async listDueInboundDeliveries(
      limit: number,
    ): Promise<IntegrationsResult<InboundDelivery[]>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM integrations_inbound_deliveries
            WHERE status IN ('received', 'attributed')
              AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            ORDER BY received_at ASC, id ASC
            LIMIT $1`,
          [limit],
        );
        return { ok: true, value: result.rows.map(mapInboundDelivery) };
      } catch {
        return safeError("Failed to list due inbound deliveries");
      }
    },

    async markInboundDelivery(
      id: Uuid,
      input: MarkInboundDeliveryInput,
    ): Promise<IntegrationsResult<InboundDelivery>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE integrations_inbound_deliveries
              SET org_id = COALESCE($2, org_id),
                  connection_id = COALESCE($3, connection_id),
                  status = COALESCE($4, status),
                  attempts = COALESCE($5, attempts),
                  next_attempt_at = $6,
                  failure_reason = COALESCE($7, failure_reason),
                  emitted_event_id = COALESCE($8, emitted_event_id),
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = $1
            RETURNING *`,
          [
            id,
            input.orgId ?? null,
            input.connectionId ?? null,
            input.status ?? null,
            input.attempts ?? null,
            isoOrNull(input.nextAttemptAt),
            input.failureReason ?? null,
            input.emittedEventId ?? null,
          ],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapInboundDelivery(result.rows[0]!) };
      } catch {
        return safeError("Failed to mark inbound delivery");
      }
    },

    // ── Installation token cache ────────────────────────────

    async upsertInstallationToken(
      input: UpsertInstallationTokenInput,
    ): Promise<IntegrationsResult<InstallationTokenCacheEntry>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO integrations_installation_tokens
             (id, connection_id, token_ciphertext, permissions, repository_ids,
              expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (connection_id) DO UPDATE SET
             token_ciphertext = EXCLUDED.token_ciphertext,
             permissions = EXCLUDED.permissions,
             repository_ids = EXCLUDED.repository_ids,
             expires_at = EXCLUDED.expires_at,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           RETURNING *`,
          [
            input.id,
            input.connectionId,
            input.tokenCiphertext,
            jsonOrNull(input.permissions),
            jsonOrNull(input.repositoryIds),
            input.expiresAt.toISOString(),
          ],
        );
        return { ok: true, value: mapInstallationToken(result.rows[0]!) };
      } catch {
        return safeError("Failed to upsert installation token");
      }
    },

    async getInstallationToken(
      connectionId: Uuid,
    ): Promise<IntegrationsResult<InstallationTokenCacheEntry>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM integrations_installation_tokens
            WHERE connection_id = $1 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
          [connectionId],
        );
        if (result.rowCount === 0) return { ok: false, error: { kind: "not_found" } };
        return { ok: true, value: mapInstallationToken(result.rows[0]!) };
      } catch {
        return safeError("Failed to get installation token");
      }
    },

    async deleteInstallationToken(
      connectionId: Uuid,
    ): Promise<IntegrationsResult<{ deleted: true }>> {
      try {
        await executor.execute(
          `DELETE FROM integrations_installation_tokens WHERE connection_id = $1`,
          [connectionId],
        );
        return { ok: true, value: { deleted: true } };
      } catch {
        return safeError("Failed to delete installation token");
      }
    },
  };
}
