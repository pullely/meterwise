import type { SqlExecutor } from "../d1/executor.js";
import type {
  ConfigRepository,
  ConfigResult,
  CreateFeatureFlagInput,
  CreateSecretMetadataInput,
  CreateSettingInput,
  CursorPosition,
  FeatureFlag,
  PagedResult,
  PageQueryParams,
  Scope,
  SecretMetadata,
  Setting,
  UpdateFeatureFlagInput,
  UpdateSettingInput,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";
import { parseBooleanColumn, parseJsonColumn, parseNullableJsonColumn } from "../json.js";

// ── Scope helpers ──────────────────────────────────────────

function scopeColumns(scope: Scope): {
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: string;
} {
  switch (scope.kind) {
    case "organization":
      return { orgId: scope.orgId, projectId: null, environmentId: null, scopeKind: "organization" };
    case "project":
      return { orgId: scope.orgId, projectId: scope.projectId, environmentId: null, scopeKind: "project" };
    case "environment":
      return { orgId: scope.orgId, projectId: scope.projectId, environmentId: scope.environmentId, scopeKind: "environment" };
  }
}

function scopeWhere(scope: Scope): { clause: string; params: unknown[] } {
  switch (scope.kind) {
    case "organization":
      return { clause: "org_id = $1 AND scope_kind = 'organization'", params: [scope.orgId] };
    case "project":
      return { clause: "org_id = $1 AND project_id = $2 AND scope_kind = 'project'", params: [scope.orgId, scope.projectId] };
    case "environment":
      return { clause: "org_id = $1 AND project_id = $2 AND environment_id = $3 AND scope_kind = 'environment'", params: [scope.orgId, scope.projectId, scope.environmentId] };
  }
}

// ── Row mappers ────────────────────────────────────────────

function mapSetting(row: Record<string, unknown>): Setting {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    scopeKind: row.scope_kind as Setting["scopeKind"],
    key: row.key as string,
    value: parseJsonColumn<unknown>(row.value, null),
    description: (row.description as string) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapFeatureFlag(row: Record<string, unknown>): FeatureFlag {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    scopeKind: row.scope_kind as FeatureFlag["scopeKind"],
    flagKey: row.flag_key as string,
    enabled: parseBooleanColumn(row.enabled),
    value: parseNullableJsonColumn<unknown>(row.value),
    description: (row.description as string) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapSecretMetadata(row: Record<string, unknown>): SecretMetadata {
  // Intentionally omit ciphertext_envelope — never expose through repository
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: (row.project_id as string) ?? null,
    environmentId: (row.environment_id as string) ?? null,
    scopeKind: row.scope_kind as SecretMetadata["scopeKind"],
    secretKey: row.secret_key as string,
    displayName: (row.display_name as string) ?? null,
    status: row.status as string,
    version: row.version as number,
    rotationPolicy: (row.rotation_policy as string) ?? null,
    lastRotatedAt: row.last_rotated_at ? new Date(row.last_rotated_at as string) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

// ── Secret metadata safe columns (no ciphertext_envelope) ──

const SECRET_METADATA_SAFE_COLUMNS = `id, org_id, project_id, environment_id, scope_kind, secret_key, display_name, status, version, rotation_policy, last_rotated_at, expires_at, created_by, created_at, updated_at`;

function safeError(message: string): ConfigResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}


function isCheckViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23514"
  );
}

// ── Paged list helper ──────────────────────────────────────

async function pagedList<T>(
  executor: SqlExecutor,
  table: string,
  scope: Scope,
  params: PageQueryParams,
  mapper: (row: Record<string, unknown>) => T,
  selectColumns = "*",
): Promise<ConfigResult<PagedResult<T>>> {
  try {
    const sw = scopeWhere(scope);
    const fetchLimit = params.limit + 1;
    const baseIdx = sw.params.length;
    let sql: string;
    let values: unknown[];
    if (params.cursor) {
      sql = `SELECT ${selectColumns} FROM ${table}
       WHERE ${sw.clause}
         AND (created_at, id) < ($${baseIdx + 2}, $${baseIdx + 3})
       ORDER BY created_at DESC, id DESC
       LIMIT $${baseIdx + 1}`;
      values = [...sw.params, fetchLimit, params.cursor.createdAt, params.cursor.id];
    } else {
      sql = `SELECT ${selectColumns} FROM ${table}
       WHERE ${sw.clause}
       ORDER BY created_at DESC, id DESC
       LIMIT $${baseIdx + 1}`;
      values = [...sw.params, fetchLimit];
    }
    const result = await executor.execute<Record<string, unknown>>(sql, values);
    const rows = result.rows.map(mapper);
    let nextCursor: CursorPosition | null = null;
    if (rows.length > params.limit) {
      rows.pop();
      const last = rows[rows.length - 1]!;
      nextCursor = {
        createdAt: (last as unknown as { createdAt: Date }).createdAt.toISOString(),
        id: (last as unknown as { id: string }).id,
      };
    }
    return { ok: true, value: { items: rows, nextCursor } };
  } catch {
    return safeError(`Failed to list from ${table}`);
  }
}

// ── Repository factory ─────────────────────────────────────

export function createConfigRepository(executor: SqlExecutor): ConfigRepository {
  return {
    // ── Settings ──────────────────────────────────────────

    async createSetting(input: CreateSettingInput): Promise<ConfigResult<Setting>> {
      try {
        const sc = scopeColumns(input.scope);
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO config_settings (id, org_id, project_id, environment_id, scope_kind, key, value, description, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'), key) DO NOTHING
           RETURNING *`,
          [input.id, sc.orgId, sc.projectId, sc.environmentId, sc.scopeKind, input.key, JSON.stringify(input.value), input.description ?? null],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "setting" } };
        }
        return { ok: true, value: mapSetting(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "setting" } };
        }
        if (isCheckViolation(err)) {
          return safeError("Invalid scope for setting");
        }
        return safeError("Failed to create setting");
      }
    },

    async updateSetting(orgId: string, settingId: string, input: UpdateSettingInput): Promise<ConfigResult<Setting>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE config_settings
           SET value = $3, description = COALESCE($4, description), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE org_id = $1 AND id = $2
           RETURNING *`,
          [orgId, settingId, JSON.stringify(input.value), input.description ?? null],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSetting(result.rows[0]!) };
      } catch {
        return safeError("Failed to update setting");
      }
    },

    async getSetting(orgId: string, settingId: string): Promise<ConfigResult<Setting>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM config_settings WHERE org_id = $1 AND id = $2`,
          [orgId, settingId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSetting(result.rows[0]!) };
      } catch {
        return safeError("Failed to get setting");
      }
    },

    async listSettings(scope: Scope, params: PageQueryParams): Promise<ConfigResult<PagedResult<Setting>>> {
      return pagedList(executor, "config_settings", scope, params, mapSetting);
    },

    // ── Feature flags ─────────────────────────────────────

    async createFeatureFlag(input: CreateFeatureFlagInput): Promise<ConfigResult<FeatureFlag>> {
      try {
        const sc = scopeColumns(input.scope);
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO config_feature_flags (id, org_id, project_id, environment_id, scope_kind, flag_key, enabled, value, description, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           ON CONFLICT (org_id, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'), COALESCE(environment_id, '00000000-0000-0000-0000-000000000000'), flag_key) DO NOTHING
           RETURNING *`,
          [input.id, sc.orgId, sc.projectId, sc.environmentId, sc.scopeKind, input.flagKey, input.enabled ?? false, input.value ? JSON.stringify(input.value) : null, input.description ?? null],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "feature_flag" } };
        }
        return { ok: true, value: mapFeatureFlag(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "feature_flag" } };
        }
        if (isCheckViolation(err)) {
          return safeError("Invalid scope for feature flag");
        }
        return safeError("Failed to create feature flag");
      }
    },

    async updateFeatureFlag(orgId: string, flagId: string, input: UpdateFeatureFlagInput): Promise<ConfigResult<FeatureFlag>> {
      try {
        const setClauses: string[] = ["updated_at = now()"];
        const values: unknown[] = [orgId, flagId];
        let idx = 3;
        if (input.enabled !== undefined) {
          setClauses.push(`enabled = $${idx}`);
          values.push(input.enabled);
          idx++;
        }
        if (input.value !== undefined) {
          setClauses.push(`value = $${idx}`);
          values.push(JSON.stringify(input.value));
          idx++;
        }
        if (input.description !== undefined) {
          setClauses.push(`description = $${idx}`);
          values.push(input.description);
          idx++;
        }
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE config_feature_flags SET ${setClauses.join(", ")} WHERE org_id = $1 AND id = $2 RETURNING *`,
          values,
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapFeatureFlag(result.rows[0]!) };
      } catch {
        return safeError("Failed to update feature flag");
      }
    },

    async getFeatureFlag(orgId: string, flagId: string): Promise<ConfigResult<FeatureFlag>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM config_feature_flags WHERE org_id = $1 AND id = $2`,
          [orgId, flagId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapFeatureFlag(result.rows[0]!) };
      } catch {
        return safeError("Failed to get feature flag");
      }
    },

    async listFeatureFlags(scope: Scope, params: PageQueryParams): Promise<ConfigResult<PagedResult<FeatureFlag>>> {
      return pagedList(executor, "config_feature_flags", scope, params, mapFeatureFlag);
    },

    // ── Secret metadata ───────────────────────────────────

    async createSecretMetadata(input: CreateSecretMetadataInput): Promise<ConfigResult<SecretMetadata>> {
      try {
        const sc = scopeColumns(input.scope);
        const hasCiphertext = input.ciphertextEnvelope !== undefined;
        const sql = hasCiphertext
          ? `INSERT INTO config_secret_metadata (id, org_id, project_id, environment_id, scope_kind, secret_key, display_name, status, version, rotation_policy, expires_at, created_by, ciphertext_envelope, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 1, $8, $9, $10, $11, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           RETURNING ${SECRET_METADATA_SAFE_COLUMNS}`
          : `INSERT INTO config_secret_metadata (id, org_id, project_id, environment_id, scope_kind, secret_key, display_name, status, version, rotation_policy, expires_at, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 1, $8, $9, $10, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           RETURNING ${SECRET_METADATA_SAFE_COLUMNS}`;
        const params = [input.id, sc.orgId, sc.projectId, sc.environmentId, sc.scopeKind, input.secretKey, input.displayName ?? null, input.rotationPolicy ?? null, input.expiresAt?.toISOString() ?? null, input.createdBy];
        if (hasCiphertext) {
          params.push(input.ciphertextEnvelope!);
        }
        const result = await executor.execute<Record<string, unknown>>(sql, params);
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "secret_metadata" } };
        }
        return { ok: true, value: mapSecretMetadata(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "secret_metadata" } };
        }
        if (isCheckViolation(err)) {
          return safeError("Invalid scope for secret metadata");
        }
        return safeError("Failed to create secret metadata");
      }
    },

    async listSecretMetadata(scope: Scope, params: PageQueryParams): Promise<ConfigResult<PagedResult<SecretMetadata>>> {
      return pagedList(executor, "config_secret_metadata", scope, params, mapSecretMetadata, SECRET_METADATA_SAFE_COLUMNS);
    },

    async getSecretMetadata(orgId: string, secretId: string): Promise<ConfigResult<SecretMetadata>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT ${SECRET_METADATA_SAFE_COLUMNS} FROM config_secret_metadata WHERE org_id = $1 AND id = $2`,
          [orgId, secretId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSecretMetadata(result.rows[0]!) };
      } catch {
        return safeError("Failed to get secret metadata");
      }
    },

    async rotateSecretMetadata(orgId: string, secretId: string, ciphertextEnvelope?: string): Promise<ConfigResult<SecretMetadata>> {
      try {
        const hasCiphertext = ciphertextEnvelope !== undefined;
        const sql = hasCiphertext
          ? `UPDATE config_secret_metadata
           SET version = version + 1, last_rotated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), ciphertext_envelope = $3
           WHERE org_id = $1 AND id = $2 AND status = 'active'
           RETURNING ${SECRET_METADATA_SAFE_COLUMNS}`
          : `UPDATE config_secret_metadata
           SET version = version + 1, last_rotated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE org_id = $1 AND id = $2 AND status = 'active'
           RETURNING ${SECRET_METADATA_SAFE_COLUMNS}`;
        const params: unknown[] = [orgId, secretId];
        if (hasCiphertext) {
          params.push(ciphertextEnvelope);
        }
        const result = await executor.execute<Record<string, unknown>>(sql, params);
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSecretMetadata(result.rows[0]!) };
      } catch {
        return safeError("Failed to rotate secret metadata");
      }
    },

    async revokeSecretMetadata(orgId: string, secretId: string): Promise<ConfigResult<SecretMetadata>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE config_secret_metadata
           SET status = 'revoked', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE org_id = $1 AND id = $2 AND status = 'active'
           RETURNING ${SECRET_METADATA_SAFE_COLUMNS}`,
          [orgId, secretId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapSecretMetadata(result.rows[0]!) };
      } catch {
        return safeError("Failed to revoke secret metadata");
      }
    },
  };
}
