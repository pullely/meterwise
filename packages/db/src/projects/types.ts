export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../d1/executor.js";
import type { Uuid } from "../ids/index.js";

export type ProjectsRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "internal"; message: string };

export type ProjectsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProjectsRepositoryError };

export interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  slugLower: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface Environment {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  slug: string;
  slugLower: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface CreateProjectInput {
  id: string;
  orgId: Uuid;
  name: string;
  slug: string;
  slugLower: string;
  createdAt: Date;
}

export interface CreateEnvironmentInput {
  id: string;
  orgId: Uuid;
  projectId: Uuid;
  name: string;
  slug: string;
  slugLower: string;
  createdAt: Date;
}

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

export interface ProjectsRepository {
  createProject(input: CreateProjectInput): Promise<ProjectsResult<Project>>;
  getProjectById(orgId: Uuid, projectId: Uuid): Promise<ProjectsResult<Project>>;
  getProjectBySlug(orgId: Uuid, slugLower: string): Promise<ProjectsResult<Project>>;
  listProjectsPaged(orgId: Uuid, params: PageQueryParams): Promise<ProjectsResult<PagedResult<Project>>>;
  archiveProject(orgId: Uuid, projectId: Uuid, archivedAt: Date): Promise<ProjectsResult<Project>>;
  /**
   * Count of active (non-archived) projects for an organization. Used by
   * domain callers (e.g. projects-worker) to compare against entitlement
   * limits without loading a full page of projects.
   */
  countActiveProjects(orgId: Uuid): Promise<ProjectsResult<number>>;

  createEnvironment(input: CreateEnvironmentInput): Promise<ProjectsResult<Environment>>;
  /**
   * Count of active (non-archived) environments under a specific parent
   * project. Used by domain callers (e.g. projects-worker) to compare
   * against `limit.environments` entitlement quotas before creating a
   * new environment row. The count is intentionally scoped to
   * `org_id + project_id` because environment APIs are project-scoped.
   */
  countActiveEnvironments(orgId: Uuid, projectId: Uuid): Promise<ProjectsResult<number>>;
  getEnvironmentById(orgId: Uuid, projectId: Uuid, environmentId: string): Promise<ProjectsResult<Environment>>;
  getEnvironmentBySlug(orgId: Uuid, projectId: Uuid, slugLower: string): Promise<ProjectsResult<Environment>>;
  listEnvironmentsPaged(orgId: Uuid, projectId: Uuid, params: PageQueryParams): Promise<ProjectsResult<PagedResult<Environment>>>;
  archiveEnvironment(orgId: Uuid, projectId: Uuid, environmentId: string, archivedAt: Date): Promise<ProjectsResult<Environment>>;
}
