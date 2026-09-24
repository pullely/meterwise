import type {
  CreateOrganizationRequest,
  CreateOrganizationResponse,
  GetOrganizationResponse,
  ListOrganizationsResponse,
} from "@saas/contracts/membership";

import type { Transport, RequestOptions } from "./transport.js";

/**
 * Organizations resource client.
 *
 * Maps 1:1 to the api-edge `/v1/organizations` surface owned by
 * `apps/membership-worker` via the `org-facade` route. POST goes through
 * the idempotency-key surface (Stripe parity — caller-owned key).
 */
export class OrganizationsClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations — orgs the actor is a member of. */
  list(opts: RequestOptions = {}): Promise<ListOrganizationsResponse> {
    return this.transport.request<ListOrganizationsResponse>(
      { method: "GET", path: "/v1/organizations" },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId */
  get(orgId: string, opts: RequestOptions = {}): Promise<GetOrganizationResponse> {
    return this.transport.request<GetOrganizationResponse>(
      { method: "GET", path: `/v1/organizations/${encodeURIComponent(orgId)}` },
      opts,
    );
  }

  /**
   * POST /v1/organizations
   *
   * Pass `idempotencyKey` in `opts` to make the request safely retryable.
   * The SDK does not auto-generate one; the server treats the key as opaque.
   */
  create(
    body: CreateOrganizationRequest,
    opts: RequestOptions = {},
  ): Promise<CreateOrganizationResponse> {
    return this.transport.request<CreateOrganizationResponse>(
      { method: "POST", path: "/v1/organizations", body },
      opts,
    );
  }
}
