// Public contract types for org-scoped API-key administration.

/** Service principal metadata attached to an API key. */
export interface PublicApiKeyServicePrincipal {
  id: string;
  displayName: string;
  role: string;
  projectId: string | null;
}

/** API key as returned by the list endpoint (no secret material). */
export interface PublicApiKey {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  servicePrincipal: PublicApiKeyServicePrincipal;
}

/** API key as returned by the create endpoint (includes one-time secret). */
export interface PublicApiKeyCreateResult {
  id: string;
  label: string;
  prefix: string;
  secret: string;
  createdAt: string;
  expiresAt: string | null;
  servicePrincipal: PublicApiKeyServicePrincipal;
}

/** API key as returned by the revoke endpoint. */
export interface PublicApiKeyRevokeResult {
  id: string;
  label: string;
  prefix: string;
  revokedAt: string;
}

/** Request body for creating an API key. */
export interface CreateApiKeyRequest {
  label: string;
  role: string;
  projectId?: string;
  expiresAt?: string;
}
