import type { SqlExecutor } from "../d1/executor.js";
import type {
  CreateEnvironmentInput,
  CreateProjectInput,
  CursorPosition,
  Environment,
  PagedResult,
  PageQueryParams,
  Project,
  ProjectsRepository,
  ProjectsResult,
} from "./types.js";
import { isUniqueViolation } from "../d1/errors.js";

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    slug: row.slug as string,
    slugLower: row.slug_lower as string,
    status: row.status as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    archivedAt: row.archived_at ? new Date(row.archived_at as string) : null,
  };
}

function mapEnvironment(row: Record<string, unknown>): Environment {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    slug: row.slug as string,
    slugLower: row.slug_lower as string,
    status: row.status as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    archivedAt: row.archived_at ? new Date(row.archived_at as string) : null,
  };
}

function safeError(message: string): ProjectsResult<never> {
  return { ok: false, error: { kind: "internal", message } };
}


export function createProjectsRepository(executor: SqlExecutor): ProjectsRepository {
  return {
    async createProject(input: CreateProjectInput): Promise<ProjectsResult<Project>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO projects_projects (id, org_id, name, slug, slug_lower, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.orgId, input.name, input.slug, input.slugLower, input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "project" } };
        }
        return { ok: true, value: mapProject(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "project" } };
        }
        return safeError("Failed to create project");
      }
    },

    async getProjectById(orgId: string, projectId: string): Promise<ProjectsResult<Project>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM projects_projects WHERE org_id = $1 AND id = $2`,
          [orgId, projectId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapProject(result.rows[0]!) };
      } catch {
        return safeError("Failed to get project");
      }
    },

    async getProjectBySlug(orgId: string, slugLower: string): Promise<ProjectsResult<Project>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM projects_projects WHERE org_id = $1 AND slug_lower = $2`,
          [orgId, slugLower],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapProject(result.rows[0]!) };
      } catch {
        return safeError("Failed to get project by slug");
      }
    },

    async listProjectsPaged(orgId: string, params: PageQueryParams): Promise<ProjectsResult<PagedResult<Project>>> {
      try {
        const fetchLimit = params.limit + 1;
        let sql: string;
        let values: unknown[];
        if (params.cursor) {
          sql = `SELECT * FROM projects_projects
           WHERE org_id = $1 AND status = 'active'
             AND (created_at, id) < ($3, $4)
           ORDER BY created_at DESC, id DESC
           LIMIT $2`;
          values = [orgId, fetchLimit, params.cursor.createdAt, params.cursor.id];
        } else {
          sql = `SELECT * FROM projects_projects
           WHERE org_id = $1 AND status = 'active'
           ORDER BY created_at DESC, id DESC
           LIMIT $2`;
          values = [orgId, fetchLimit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        const rows = result.rows.map(mapProject);
        let nextCursor: CursorPosition | null = null;
        if (rows.length > params.limit) {
          rows.pop();
          const last = rows[rows.length - 1]!;
          nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
        }
        return { ok: true, value: { items: rows, nextCursor } };
      } catch {
        return safeError("Failed to list projects");
      }
    },

    async archiveProject(orgId: string, projectId: string, archivedAt: Date): Promise<ProjectsResult<Project>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE projects_projects
           SET status = 'archived', archived_at = $3, updated_at = $3
           WHERE org_id = $1 AND id = $2 AND status = 'active'
           RETURNING *`,
          [orgId, projectId, archivedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapProject(result.rows[0]!) };
      } catch {
        return safeError("Failed to archive project");
      }
    },

    async countActiveProjects(orgId: string): Promise<ProjectsResult<number>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT COUNT(*) AS count FROM projects_projects
           WHERE org_id = $1 AND status = 'active'`,
          [orgId],
        );
        const row = result.rows[0];
        const raw = row ? (row.count as string | number | bigint | null) : 0;
        // pg may return bigint as string; coerce to a JS number defensively.
        // Realistic project counts per org fit comfortably below Number.MAX_SAFE_INTEGER.
        const count =
          typeof raw === "number"
            ? raw
            : typeof raw === "bigint"
              ? Number(raw)
              : raw == null
                ? 0
                : Number(raw);
        if (!Number.isFinite(count) || count < 0) {
          return safeError("Failed to count active projects");
        }
        return { ok: true, value: count };
      } catch {
        return safeError("Failed to count active projects");
      }
    },

    async createEnvironment(input: CreateEnvironmentInput): Promise<ProjectsResult<Environment>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `INSERT INTO projects_environments (id, org_id, project_id, name, slug, slug_lower, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
           ON CONFLICT (id) DO NOTHING
           RETURNING *`,
          [input.id, input.orgId, input.projectId, input.name, input.slug, input.slugLower, input.createdAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "conflict", entity: "environment" } };
        }
        return { ok: true, value: mapEnvironment(result.rows[0]!) };
      } catch (err: unknown) {
        if (isUniqueViolation(err)) {
          return { ok: false, error: { kind: "conflict", entity: "environment" } };
        }
        return safeError("Failed to create environment");
      }
    },

    async countActiveEnvironments(orgId: string, projectId: string): Promise<ProjectsResult<number>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT COUNT(*) AS count FROM projects_environments
           WHERE org_id = $1 AND project_id = $2 AND status = 'active'`,
          [orgId, projectId],
        );
        const row = result.rows[0];
        const raw = row ? (row.count as string | number | bigint | null) : 0;
        // pg may return bigint as string; coerce to a JS number defensively.
        // Realistic environment counts per project fit comfortably below
        // Number.MAX_SAFE_INTEGER.
        const count =
          typeof raw === "number"
            ? raw
            : typeof raw === "bigint"
              ? Number(raw)
              : raw == null
                ? 0
                : Number(raw);
        if (!Number.isFinite(count) || count < 0) {
          return safeError("Failed to count active environments");
        }
        return { ok: true, value: count };
      } catch {
        return safeError("Failed to count active environments");
      }
    },

    async getEnvironmentById(orgId: string, projectId: string, environmentId: string): Promise<ProjectsResult<Environment>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM projects_environments WHERE org_id = $1 AND project_id = $2 AND id = $3`,
          [orgId, projectId, environmentId],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapEnvironment(result.rows[0]!) };
      } catch {
        return safeError("Failed to get environment");
      }
    },

    async getEnvironmentBySlug(orgId: string, projectId: string, slugLower: string): Promise<ProjectsResult<Environment>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `SELECT * FROM projects_environments WHERE org_id = $1 AND project_id = $2 AND slug_lower = $3`,
          [orgId, projectId, slugLower],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapEnvironment(result.rows[0]!) };
      } catch {
        return safeError("Failed to get environment by slug");
      }
    },

    async listEnvironmentsPaged(orgId: string, projectId: string, params: PageQueryParams): Promise<ProjectsResult<PagedResult<Environment>>> {
      try {
        const fetchLimit = params.limit + 1;
        let sql: string;
        let values: unknown[];
        if (params.cursor) {
          sql = `SELECT * FROM projects_environments
           WHERE org_id = $1 AND project_id = $2 AND status = 'active'
             AND (created_at, id) < ($4, $5)
           ORDER BY created_at DESC, id DESC
           LIMIT $3`;
          values = [orgId, projectId, fetchLimit, params.cursor.createdAt, params.cursor.id];
        } else {
          sql = `SELECT * FROM projects_environments
           WHERE org_id = $1 AND project_id = $2 AND status = 'active'
           ORDER BY created_at DESC, id DESC
           LIMIT $3`;
          values = [orgId, projectId, fetchLimit];
        }
        const result = await executor.execute<Record<string, unknown>>(sql, values);
        const rows = result.rows.map(mapEnvironment);
        let nextCursor: CursorPosition | null = null;
        if (rows.length > params.limit) {
          rows.pop();
          const last = rows[rows.length - 1]!;
          nextCursor = { createdAt: last.createdAt.toISOString(), id: last.id };
        }
        return { ok: true, value: { items: rows, nextCursor } };
      } catch {
        return safeError("Failed to list environments");
      }
    },

    async archiveEnvironment(orgId: string, projectId: string, environmentId: string, archivedAt: Date): Promise<ProjectsResult<Environment>> {
      try {
        const result = await executor.execute<Record<string, unknown>>(
          `UPDATE projects_environments
           SET status = 'archived', archived_at = $4, updated_at = $4
           WHERE org_id = $1 AND project_id = $2 AND id = $3 AND status = 'active'
           RETURNING *`,
          [orgId, projectId, environmentId, archivedAt.toISOString()],
        );
        if (result.rowCount === 0) {
          return { ok: false, error: { kind: "not_found" } };
        }
        return { ok: true, value: mapEnvironment(result.rows[0]!) };
      } catch {
        return safeError("Failed to archive environment");
      }
    },
  };
}
