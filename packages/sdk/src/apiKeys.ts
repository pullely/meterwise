import type {
  CreateApiKeyRequest,
  PublicApiKey,
  PublicApiKeyCreateResult,
  PublicApiKeyRevokeResult,
} from "@saas/contracts/api-keys";

import type { RequestOptions, Transport } from "./transport.js";

/**
 * API Keys resource client.
 *
 * Org-scoped surface served by `apps/identity-worker` via the api-edge
 * `org-facade` routes. The `create` response carries a one-time secret
 * material reveal — callers MUST persist it immediately; subsequent list
 * calls only return the prefix.
 */

export interface ListApiKeysResponse {
  apiKeys: PublicApiKey[];
}

export interface GetApiKeyResponse {
  apiKey: PublicApiKey;
}

export interface CreateApiKeyResponse {
  apiKey: PublicApiKeyCreateResult;
}

export interface RevokeApiKeyResponse {
  apiKey: PublicApiKeyRevokeResult;
}

export class ApiKeysClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/api-keys */
  list(orgId: string, opts: RequestOptions = {}): Promise<ListApiKeysResponse> {
    return this.transport.request<ListApiKeysResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/api-keys`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/api-keys/:apiKeyId */
  get(
    orgId: string,
    apiKeyId: string,
    opts: RequestOptions = {},
  ): Promise<GetApiKeyResponse> {
    return this.transport.request<GetApiKeyResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/api-keys/${encodeURIComponent(apiKeyId)}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/api-keys
   *
   * The response carries a one-time-reveal `secret`. Pass `idempotencyKey`
   * in `opts` for safe retry semantics (Stripe parity — caller-owned key).
   */
  create(
    orgId: string,
    body: CreateApiKeyRequest,
    opts: RequestOptions = {},
  ): Promise<CreateApiKeyResponse> {
    return this.transport.request<CreateApiKeyResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/api-keys`,
        body,
      },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/api-keys/:apiKeyId */
  revoke(
    orgId: string,
    apiKeyId: string,
    opts: RequestOptions = {},
  ): Promise<RevokeApiKeyResponse> {
    return this.transport.request<RevokeApiKeyResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/api-keys/${encodeURIComponent(apiKeyId)}`,
      },
      opts,
    );
  }
}
