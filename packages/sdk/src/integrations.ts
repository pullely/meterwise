import type {
  ConnectIntegrationRequest,
  IssueIntegrationTokenRequest,
  IssueIntegrationTokenResponse,
  CreateRepoLinkRequest,
  CreateRepoLinkResponse,
  DeleteRepoLinkResponse,
  ListRepoLinksResponse,
  ListRepositoriesResponse,
  UpdateRepoLinkRequest,
  UpdateRepoLinkResponse,
  ConnectIntegrationResponse,
  GetIntegrationResponse,
  ListIntegrationsResponse,
  ListInboundDeliveriesResponse,
  ReplayInboundDeliveryResponse,
  RevokeIntegrationResponse,
} from "@saas/contracts/integrations";

import type { Transport, RequestOptions } from "./transport.js";

/**
 * Integrations resource client (GitHub App connections).
 *
 * Org-scoped: every method takes `orgId` as the first argument.
 * Maps to `apps/integrations-worker` via the api-edge `integrations-facade`.
 */
export class IntegrationsClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/integrations */
  list(orgId: string, opts: RequestOptions = {}): Promise<ListIntegrationsResponse> {
    return this.transport.request<ListIntegrationsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/integrations/:connectionId */
  get(orgId: string, connectionId: string, opts: RequestOptions = {}): Promise<GetIntegrationResponse> {
    return this.transport.request<GetIntegrationResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/integrations/github/connect
   *
   * Returns a pending connection plus the provider install URL carrying the
   * signed single-use state; open the URL in a popup and poll `get` until the
   * connection turns `active`.
   */
  connectGithub(
    orgId: string,
    body: ConnectIntegrationRequest = {},
    opts: RequestOptions = {},
  ): Promise<ConnectIntegrationResponse> {
    return this.transport.request<ConnectIntegrationResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/github/connect`,
        body,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/integrations/:connectionId/deliveries */
  listDeliveries(
    orgId: string,
    connectionId: string,
    opts: RequestOptions = {},
  ): Promise<ListInboundDeliveriesResponse> {
    return this.transport.request<ListInboundDeliveriesResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/deliveries`,
      },
      opts,
    );
  }

  /**
   * POST .../integrations/:connectionId/deliveries/:deliveryId/replay
   *
   * Re-runs normalize/emit from the persisted inbox row — never re-trusts
   * the wire.
   */
  replayDelivery(
    orgId: string,
    connectionId: string,
    deliveryId: string,
    opts: RequestOptions = {},
  ): Promise<ReplayInboundDeliveryResponse> {
    return this.transport.request<ReplayInboundDeliveryResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
        body: {},
      },
      opts,
    );
  }

  /** GET .../integrations/:connectionId/repositories?query= */
  listRepositories(
    orgId: string,
    connectionId: string,
    query?: string,
    opts: RequestOptions = {},
  ): Promise<ListRepositoriesResponse> {
    const qs = query ? `?query=${encodeURIComponent(query)}` : "";
    return this.transport.request<ListRepositoriesResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}/repositories${qs}`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/projects/:projectId/repo-links */
  listRepoLinks(
    orgId: string,
    projectId: string,
    opts: RequestOptions = {},
  ): Promise<ListRepoLinksResponse> {
    return this.transport.request<ListRepoLinksResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/repo-links`,
      },
      opts,
    );
  }

  /** POST /v1/organizations/:orgId/projects/:projectId/repo-links */
  createRepoLink(
    orgId: string,
    projectId: string,
    body: CreateRepoLinkRequest,
    opts: RequestOptions = {},
  ): Promise<CreateRepoLinkResponse> {
    return this.transport.request<CreateRepoLinkResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/repo-links`,
        body,
      },
      opts,
    );
  }

  /** PATCH .../repo-links/:repoLinkId */
  updateRepoLink(
    orgId: string,
    projectId: string,
    repoLinkId: string,
    body: UpdateRepoLinkRequest,
    opts: RequestOptions = {},
  ): Promise<UpdateRepoLinkResponse> {
    return this.transport.request<UpdateRepoLinkResponse>(
      {
        method: "PATCH",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/repo-links/${encodeURIComponent(repoLinkId)}`,
        body,
      },
      opts,
    );
  }

  /** DELETE .../repo-links/:repoLinkId (soft unlink) */
  unlinkRepoLink(
    orgId: string,
    projectId: string,
    repoLinkId: string,
    opts: RequestOptions = {},
  ): Promise<DeleteRepoLinkResponse> {
    return this.transport.request<DeleteRepoLinkResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/repo-links/${encodeURIComponent(repoLinkId)}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/integrations/github/token — the broker.
   *
   * Exchanges the caller's control-plane credential for a short-lived
   * (≤1h), repo-scoped GitHub installation token. Repositories must be
   * linked to projects in the organization; permissions must be within the
   * App's grant. The token is returned exactly once — handle it like a
   * password and let it expire (it is never cached platform-side).
   */
  issueGithubToken(
    orgId: string,
    body: IssueIntegrationTokenRequest,
    opts: RequestOptions = {},
  ): Promise<IssueIntegrationTokenResponse> {
    return this.transport.request<IssueIntegrationTokenResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/github/token`,
        body,
      },
      opts,
    );
  }

  /** DELETE /v1/organizations/:orgId/integrations/:connectionId */
  revoke(
    orgId: string,
    connectionId: string,
    opts: RequestOptions = {},
  ): Promise<RevokeIntegrationResponse> {
    return this.transport.request<RevokeIntegrationResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/integrations/${encodeURIComponent(connectionId)}`,
      },
      opts,
    );
  }
}
