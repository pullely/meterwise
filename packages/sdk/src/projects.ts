import type {
  ArchiveProjectResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  GetProjectResponse,
  ListProjectsResponse,
} from "@saas/contracts/projects";

import type { Transport, RequestOptions } from "./transport.js";

/**
 * Projects resource client.
 *
 * Org-scoped: every method takes `orgId` as the first argument.
 * Maps to `apps/projects-worker` via the api-edge `project-facade` route.
 */
export class ProjectsClient {
  constructor(private readonly transport: Transport) {}

  /** GET /v1/organizations/:orgId/projects */
  list(orgId: string, opts: RequestOptions = {}): Promise<ListProjectsResponse> {
    return this.transport.request<ListProjectsResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects`,
      },
      opts,
    );
  }

  /** GET /v1/organizations/:orgId/projects/:projectId */
  get(
    orgId: string,
    projectId: string,
    opts: RequestOptions = {},
  ): Promise<GetProjectResponse> {
    return this.transport.request<GetProjectResponse>(
      {
        method: "GET",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`,
      },
      opts,
    );
  }

  /**
   * POST /v1/organizations/:orgId/projects
   *
   * Pass `idempotencyKey` in `opts` for safe retry semantics.
   */
  create(
    orgId: string,
    body: CreateProjectRequest,
    opts: RequestOptions = {},
  ): Promise<CreateProjectResponse> {
    return this.transport.request<CreateProjectResponse>(
      {
        method: "POST",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects`,
        body,
      },
      opts,
    );
  }

  /**
   * DELETE /v1/organizations/:orgId/projects/:projectId
   *
   * api-edge maps this to a soft-archive on the projects-worker; the response
   * envelope returns the archived `PublicProject` shape.
   */
  archive(
    orgId: string,
    projectId: string,
    opts: RequestOptions = {},
  ): Promise<ArchiveProjectResponse> {
    return this.transport.request<ArchiveProjectResponse>(
      {
        method: "DELETE",
        path: `/v1/organizations/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`,
      },
      opts,
    );
  }
}
