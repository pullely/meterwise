import type { Setting, FeatureFlag, SecretMetadata } from "@saas/db/config";
import type { PublicSetting, PublicFeatureFlag, PublicSecretMetadata } from "@saas/contracts/config";
import {
  orgPublicId,
  settingPublicId,
  featureFlagPublicId,
  secretMetadataPublicId,
} from "./ids.js";

function projectPublicId(uuid: string): string {
  return `prj_${uuid.replace(/-/g, "")}`;
}

function environmentPublicId(uuid: string): string {
  return `env_${uuid.replace(/-/g, "")}`;
}

function toISOString(d: Date): string {
  return d.toISOString();
}

function mapScopeIds(row: { orgId: string; projectId: string | null; environmentId: string | null }) {
  return {
    orgId: orgPublicId(row.orgId),
    projectId: row.projectId ? projectPublicId(row.projectId) : null,
    environmentId: row.environmentId ? environmentPublicId(row.environmentId) : null,
  };
}

export function toPublicSetting(s: Setting): PublicSetting {
  return {
    id: settingPublicId(s.id),
    ...mapScopeIds(s),
    scopeKind: s.scopeKind,
    key: s.key,
    value: s.value,
    description: s.description,
    createdAt: toISOString(s.createdAt),
    updatedAt: toISOString(s.updatedAt),
  };
}

export function toPublicFeatureFlag(f: FeatureFlag): PublicFeatureFlag {
  return {
    id: featureFlagPublicId(f.id),
    ...mapScopeIds(f),
    scopeKind: f.scopeKind,
    flagKey: f.flagKey,
    enabled: f.enabled,
    value: f.value,
    description: f.description,
    createdAt: toISOString(f.createdAt),
    updatedAt: toISOString(f.updatedAt),
  };
}

export function toPublicSecretMetadata(s: SecretMetadata): PublicSecretMetadata {
  return {
    id: secretMetadataPublicId(s.id),
    ...mapScopeIds(s),
    scopeKind: s.scopeKind,
    secretKey: s.secretKey,
    displayName: s.displayName,
    status: s.status,
    version: s.version,
    rotationPolicy: s.rotationPolicy,
    lastRotatedAt: s.lastRotatedAt ? toISOString(s.lastRotatedAt) : null,
    expiresAt: s.expiresAt ? toISOString(s.expiresAt) : null,
    createdBy: s.createdBy,
    createdAt: toISOString(s.createdAt),
    updatedAt: toISOString(s.updatedAt),
  };
}
