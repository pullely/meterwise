export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../d1/executor.js";
import type { Uuid } from "../ids/index.js";

// ── Shared scope types ──────────────────────────────────────

export type ScopeKind = "organization" | "project" | "environment";

export interface OrgScope {
  kind: "organization";
  orgId: string;
}

export interface ProjectScope {
  kind: "project";
  orgId: string;
  projectId: string;
}

export interface EnvironmentScope {
  kind: "environment";
  orgId: string;
  projectId: string;
  environmentId: string;
}

export type Scope = OrgScope | ProjectScope | EnvironmentScope;

// ── Result type ─────────────────────────────────────────────

export type ConfigRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type ConfigResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConfigRepositoryError };

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

// ── Settings ────────────────────────────────────────────────

export interface Setting {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: ScopeKind;
  key: string;
  value: unknown;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateSettingInput {
  id: string;
  scope: Scope;
  key: string;
  value: unknown;
  description?: string;
}

export interface UpdateSettingInput {
  value: unknown;
  description?: string;
}

// ── Feature flags ───────────────────────────────────────────

export interface FeatureFlag {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: ScopeKind;
  flagKey: string;
  enabled: boolean;
  value: unknown | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateFeatureFlagInput {
  id: string;
  scope: Scope;
  flagKey: string;
  enabled?: boolean;
  value?: unknown;
  description?: string;
}

export interface UpdateFeatureFlagInput {
  enabled?: boolean;
  value?: unknown;
  description?: string;
}

// ── Secret metadata ─────────────────────────────────────────
// NOTE: No plaintext secret value fields. Only metadata.

export interface SecretMetadata {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: ScopeKind;
  secretKey: string;
  displayName: string | null;
  status: string;
  version: number;
  rotationPolicy: string | null;
  lastRotatedAt: Date | null;
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  // NOTE: ciphertext_envelope is intentionally excluded from the type.
  // It is never exposed through the repository read surface.
}

export interface CreateSecretMetadataInput {
  id: string;
  scope: Scope;
  secretKey: string;
  displayName?: string;
  rotationPolicy?: string;
  expiresAt?: Date;
  /** UUID column `config_secret_metadata.created_by` — must be a decoded `Uuid`,
   * not a public `usr_<hex>` id. Branding makes a missing decode a compile error. */
  createdBy: Uuid;
  /** JSON-serialized ciphertext envelope. Write-only — never returned. */
  ciphertextEnvelope?: string;
}

// ── Repository interface ────────────────────────────────────

export interface ConfigRepository {
  // Settings
  createSetting(input: CreateSettingInput): Promise<ConfigResult<Setting>>;
  updateSetting(orgId: string, settingId: string, input: UpdateSettingInput): Promise<ConfigResult<Setting>>;
  getSetting(orgId: string, settingId: string): Promise<ConfigResult<Setting>>;
  listSettings(scope: Scope, params: PageQueryParams): Promise<ConfigResult<PagedResult<Setting>>>;

  // Feature flags
  createFeatureFlag(input: CreateFeatureFlagInput): Promise<ConfigResult<FeatureFlag>>;
  updateFeatureFlag(orgId: string, flagId: string, input: UpdateFeatureFlagInput): Promise<ConfigResult<FeatureFlag>>;
  getFeatureFlag(orgId: string, flagId: string): Promise<ConfigResult<FeatureFlag>>;
  listFeatureFlags(scope: Scope, params: PageQueryParams): Promise<ConfigResult<PagedResult<FeatureFlag>>>;

  // Secret metadata
  createSecretMetadata(input: CreateSecretMetadataInput): Promise<ConfigResult<SecretMetadata>>;
  listSecretMetadata(scope: Scope, params: PageQueryParams): Promise<ConfigResult<PagedResult<SecretMetadata>>>;
  getSecretMetadata(orgId: string, secretId: string): Promise<ConfigResult<SecretMetadata>>;
  rotateSecretMetadata(orgId: string, secretId: string, ciphertextEnvelope?: string): Promise<ConfigResult<SecretMetadata>>;
  revokeSecretMetadata(orgId: string, secretId: string): Promise<ConfigResult<SecretMetadata>>;
}
