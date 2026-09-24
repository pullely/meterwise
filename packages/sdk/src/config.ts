import type {
  CreateFeatureFlagRequest,
  CreateFeatureFlagResponse,
  CreateSecretMetadataResponse,
  CreateSecretRequest,
  CreateSettingRequest,
  CreateSettingResponse,
  ListFeatureFlagsResponse,
  ListSecretMetadataResponse,
  ListSettingsResponse,
  RevokeSecretMetadataResponse,
  RotateSecretMetadataResponse,
  RotateSecretRequest,
  UpdateFeatureFlagRequest,
  UpdateFeatureFlagResponse,
  UpdateSettingRequest,
  UpdateSettingResponse,
} from "@saas/contracts/config";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * Config (settings / feature-flags / secrets-metadata) resource client.
 *
 * Backed by `apps/config-worker` via the api-edge `config-facade`. The facade
 * exposes the same three resource families at three scopes — organization,
 * project, and environment — each surfaced here as a single flat method that
 * takes a discriminated `scope` argument so call sites stay grep-able and the
 * SDK doesn't fan out into a nine-permutation method tree.
 *
 * Secret values are write-only: `createSecretMetadata` and `rotateSecret`
 * accept a `value` field that the worker encrypts before persistence and that
 * NEVER appears in any response. List responses carry metadata only.
 */

/** Discriminated scope identifying which surface the call targets. */
export type ConfigScope =
  | { kind: "organization"; orgId: string }
  | { kind: "project"; orgId: string; projectId: string }
  | {
      kind: "environment";
      orgId: string;
      projectId: string;
      environmentId: string;
    };

export class ConfigClient {
  constructor(private readonly transport: Transport) {}

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /** GET <scope>/config/settings */
  listSettings(
    scope: ConfigScope,
    opts: RequestOptions = {},
  ): Promise<ListSettingsResponse> {
    return this.transport.request<ListSettingsResponse>(
      { method: "GET", path: `${scopeBase(scope)}/settings` },
      opts,
    );
  }

  /** POST <scope>/config/settings */
  createSetting(
    scope: ConfigScope,
    body: CreateSettingRequest,
    opts: RequestOptions = {},
  ): Promise<CreateSettingResponse> {
    return this.transport.request<CreateSettingResponse>(
      { method: "POST", path: `${scopeBase(scope)}/settings`, body },
      opts,
    );
  }

  /** PATCH <scope>/config/settings/:settingId — addressed by public id (`set_…`), not key. */
  updateSetting(
    scope: ConfigScope,
    settingId: string,
    body: UpdateSettingRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateSettingResponse> {
    return this.transport.request<UpdateSettingResponse>(
      {
        method: "PATCH",
        path: `${scopeBase(scope)}/settings/${encodeURIComponent(settingId)}`,
        body,
      },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Feature flags
  // -------------------------------------------------------------------------

  /** GET <scope>/config/feature-flags */
  listFeatureFlags(
    scope: ConfigScope,
    opts: RequestOptions = {},
  ): Promise<ListFeatureFlagsResponse> {
    return this.transport.request<ListFeatureFlagsResponse>(
      { method: "GET", path: `${scopeBase(scope)}/feature-flags` },
      opts,
    );
  }

  /** POST <scope>/config/feature-flags */
  createFeatureFlag(
    scope: ConfigScope,
    body: CreateFeatureFlagRequest,
    opts: RequestOptions = {},
  ): Promise<CreateFeatureFlagResponse> {
    return this.transport.request<CreateFeatureFlagResponse>(
      { method: "POST", path: `${scopeBase(scope)}/feature-flags`, body },
      opts,
    );
  }

  /** PATCH <scope>/config/feature-flags/:flagId — addressed by public id (`flg_…`), not key. */
  updateFeatureFlag(
    scope: ConfigScope,
    flagId: string,
    body: UpdateFeatureFlagRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateFeatureFlagResponse> {
    return this.transport.request<UpdateFeatureFlagResponse>(
      {
        method: "PATCH",
        path: `${scopeBase(scope)}/feature-flags/${encodeURIComponent(flagId)}`,
        body,
      },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // Secrets (metadata-only reads; write-only `value` on create/rotate)
  // -------------------------------------------------------------------------

  /** GET <scope>/config/secrets */
  listSecretMetadata(
    scope: ConfigScope,
    opts: RequestOptions = {},
  ): Promise<ListSecretMetadataResponse> {
    return this.transport.request<ListSecretMetadataResponse>(
      { method: "GET", path: `${scopeBase(scope)}/secrets` },
      opts,
    );
  }

  /**
   * POST <scope>/config/secrets
   *
   * The `value` field is write-only — the api-edge worker encrypts it before
   * persistence and the response carries metadata only.
   */
  createSecretMetadata(
    scope: ConfigScope,
    body: CreateSecretRequest,
    opts: RequestOptions = {},
  ): Promise<CreateSecretMetadataResponse> {
    return this.transport.request<CreateSecretMetadataResponse>(
      { method: "POST", path: `${scopeBase(scope)}/secrets`, body },
      opts,
    );
  }

  /**
   * POST <scope>/config/secrets/:secretId/rotate — addressed by public id (`sec_…`), not key.
   *
   * Rotates a secret's value. Write-only — the rotated value is never echoed
   * back in any response, event, or audit payload.
   */
  rotateSecret(
    scope: ConfigScope,
    secretId: string,
    body: RotateSecretRequest,
    opts: RequestOptions = {},
  ): Promise<RotateSecretMetadataResponse> {
    return this.transport.request<RotateSecretMetadataResponse>(
      {
        method: "POST",
        path: `${scopeBase(scope)}/secrets/${encodeURIComponent(secretId)}/rotate`,
        body,
      },
      opts,
    );
  }

  /** DELETE <scope>/config/secrets/:secretId — soft-delete (revoke); addressed by public id (`sec_…`). */
  revokeSecret(
    scope: ConfigScope,
    secretId: string,
    opts: RequestOptions = {},
  ): Promise<RevokeSecretMetadataResponse> {
    return this.transport.request<RevokeSecretMetadataResponse>(
      {
        method: "DELETE",
        path: `${scopeBase(scope)}/secrets/${encodeURIComponent(secretId)}`,
      },
      opts,
    );
  }
}

function scopeBase(scope: ConfigScope): string {
  switch (scope.kind) {
    case "organization":
      return `/v1/organizations/${encodeURIComponent(scope.orgId)}/config`;
    case "project":
      return `/v1/organizations/${encodeURIComponent(scope.orgId)}/projects/${encodeURIComponent(scope.projectId)}/config`;
    case "environment":
      return `/v1/organizations/${encodeURIComponent(scope.orgId)}/projects/${encodeURIComponent(scope.projectId)}/environments/${encodeURIComponent(scope.environmentId)}/config`;
  }
}
