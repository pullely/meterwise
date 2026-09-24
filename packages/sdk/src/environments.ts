import type {
  ArchiveEnvironmentResponse,
  CreateEnvironmentRequest,
  CreateEnvironmentResponse,
  GetEnvironmentResponse,
  ListEnvironmentsResponse,
} from "@saas/contracts/projects";

import type { Transport, RequestOptions } from "./transport.js";

/**
 * Environments resource client.
 *
 * Project-scoped: every method takes `orgId` + `projectId` as the first two
 * arguments. Maps to `apps/projects-worker` via the api-edge `project-facade`
 * route (`ORG_PROJECT_ENVIRONMENTS_RE` /
 * `ORG_PROJECT_ENVIRONMENT_ID_RE`). Mirrors the `ProjectsClient` shape so
 * callers see a uniform resource namespace.
 *
 * Stripe parity: `create` and `archive` accept a caller-owned
 * `idempotencyKey` via `RequestOptions`; the SDK never auto-generates one.
 */
export class EnvironmentsClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/projects/:projectId/environments */
  list(
    orgId: string,
    projectId: string,
    opts: RequestOptions = {},
  ): Promise<ListEnvironmentsResponse> {
    return this.transport.request<ListEnvironmentsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/environments`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/projects/:projectId/environments/:envId */
  get(
    orgId: string,
    projectId: string,
    envId: string,
    opts: RequestOptions = {},
  ): Promise<GetEnvironmentResponse> {
    return this.transport.request<GetEnvironmentResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(envId)}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/projects/:projectId/environments
   *
   * Pass `idempotencyKey` in `opts` for safe retry semantics (Stripe parity).
   */
  create(
    orgId: string,
    projectId: string,
    body: CreateEnvironmentRequest,
    opts: RequestOptions = {},
  ): Promise<CreateEnvironmentResponse> {
    return this.transport.request<CreateEnvironmentResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/environments`,
        body,
      },
      opts,
    );
  }

  /**
   * DELETE /v1/organizations/:orgId/projects/:projectId/environments/:envId
   *
   * api-edge maps this to a soft-archive on the projects-worker; the response
   * envelope returns the archived `PublicEnvironment` shape.
   */
  archive(
    orgId: string,
    projectId: string,
    envId: string,
    opts: RequestOptions = {},
  ): Promise<ArchiveEnvironmentResponse> {
    return this.transport.request<ArchiveEnvironmentResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(envId)}`,
      },
      opts,
    );
  }
}
