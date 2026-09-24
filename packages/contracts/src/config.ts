/**
 * Config, feature-flag, and secret-metadata contract types.
 *
 * These types define the public API request/response shapes for the config-worker
 * surface. Mutation types are included for settings and feature flags.
 * No secret value mutation types are included.
 */

// ---------------------------------------------------------------------------
// Public Setting
// ---------------------------------------------------------------------------

export interface PublicSetting {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: string;
  key: string;
  value: unknown;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListSettingsResponse {
  settings: PublicSetting[];
}

// ---------------------------------------------------------------------------
// Setting Mutation Requests
// ---------------------------------------------------------------------------

export interface CreateSettingRequest {
  key: string;
  value: unknown;
  description?: string | null;
}

export interface UpdateSettingRequest {
  value: unknown;
  description?: string | null;
}

export interface CreateSettingResponse {
  setting: PublicSetting;
}

export interface UpdateSettingResponse {
  setting: PublicSetting;
}

// ---------------------------------------------------------------------------
// Public Feature Flag
// ---------------------------------------------------------------------------

export interface PublicFeatureFlag {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: string;
  flagKey: string;
  enabled: boolean;
  value: unknown | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListFeatureFlagsResponse {
  featureFlags: PublicFeatureFlag[];
}

// ---------------------------------------------------------------------------
// Feature Flag Mutation Requests
// ---------------------------------------------------------------------------

export interface CreateFeatureFlagRequest {
  flagKey: string;
  enabled?: boolean;
  value?: unknown;
  description?: string | null;
}

export interface UpdateFeatureFlagRequest {
  enabled?: boolean;
  value?: unknown;
  description?: string | null;
}

export interface CreateFeatureFlagResponse {
  featureFlag: PublicFeatureFlag;
}

export interface UpdateFeatureFlagResponse {
  featureFlag: PublicFeatureFlag;
}

// ---------------------------------------------------------------------------
// Public Secret Metadata
// ---------------------------------------------------------------------------
// NOTE: No plaintext value, ciphertext envelope, hash, token, or raw secret
// material may ever appear in this type.

export interface PublicSecretMetadata {
  id: string;
  orgId: string;
  projectId: string | null;
  environmentId: string | null;
  scopeKind: string;
  secretKey: string;
  displayName: string | null;
  status: string;
  version: number;
  rotationPolicy: string | null;
  lastRotatedAt: string | null;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListSecretMetadataResponse {
  secrets: PublicSecretMetadata[];
}

// ---------------------------------------------------------------------------
// Secret Metadata Mutation Requests
// ---------------------------------------------------------------------------
// NOTE: The `value` field on CreateSecretRequest and RotateSecretRequest is
// write-only — it is accepted during creation/rotation, encrypted in the
// worker before persistence, and NEVER returned in any response, event, or
// audit payload. No ciphertext, hash, or raw secret material appears in
// responses.

/** Metadata-only secret creation (no encrypted value). */
export interface CreateSecretMetadataRequest {
  secretKey: string;
  displayName?: string | null;
  rotationPolicy?: string | null;
  expiresAt?: string | null;
}

/** Write-only secret creation with an encrypted value. */
export interface CreateSecretRequest {
  secretKey: string;
  /** Write-only secret value. Encrypted before persistence; never returned. */
  value: string;
  displayName?: string | null;
  rotationPolicy?: string | null;
  expiresAt?: string | null;
}

export interface CreateSecretMetadataResponse {
  secret: PublicSecretMetadata;
}

/** Write-only secret rotation with a replacement value. */
export interface RotateSecretRequest {
  /** Write-only replacement secret value. Encrypted before persistence; never returned. */
  value: string;
}

export interface RotateSecretMetadataResponse {
  secret: PublicSecretMetadata;
}

export interface RevokeSecretMetadataResponse {
  secret: PublicSecretMetadata;
}
