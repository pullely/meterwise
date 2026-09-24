import {
  createProjectsRepository,
} from "@saas/db/projects";
import { asUuid } from "@saas/db";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";

const ORG_ID = asUuid("aaaaaaaa-0001-0001-0001-000000000001");
const PRJ_ID = asUuid("bbbbbbbb-0001-0001-0001-000000000001");

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(options?: {
  rows?: Record<string, unknown>[];
  error?: unknown;
  rowCount?: number;
}): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      if (options?.error) {
        throw options.error;
      }
      const rows = (options?.rows ?? []) as unknown as T[];
      return { rows, rowCount: options?.rowCount ?? rows.length };
    },
  };
  return { executor, queries };
}

const NOW = new Date("2026-01-15T10:00:00Z");

const SAMPLE_PROJECT_ROW = {
  id: "prj-001",
  org_id: ORG_ID,
  name: "My Project",
  slug: "my-project",
  slug_lower: "my-project",
  status: "active",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  archived_at: null,
};

const SAMPLE_ENVIRONMENT_ROW = {
  id: "env-001",
  org_id: ORG_ID,
  project_id: "prj-001",
  name: "Production",
  slug: "production",
  slug_lower: "production",
  status: "active",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  archived_at: null,
};

describe("ProjectsRepository", () => {
  describe("createProject", () => {
    it("uses parameterized query for project creation", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_PROJECT_ROW] });
      const repo = createProjectsRepository(executor);

      await repo.createProject({
        id: "prj-001",
        orgId: ORG_ID,
        name: "My Project",
        slug: "my-project",
        slugLower: "my-project",
        createdAt: NOW,
      });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.text).toContain("$2");
      expect(queries[0]!.text).toContain("$3");
      expect(queries[0]!.text).toContain("$4");
      expect(queries[0]!.text).toContain("$5");
      expect(queries[0]!.text).toContain("$6");
      expect(queries[0]!.params).toEqual([
        "prj-001",
        ORG_ID,
        "My Project",
        "my-project",
        "my-project",
        NOW.toISOString(),
      ]);
    });

    it("maps returned row to Project type", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_PROJECT_ROW] });
      const repo = createProjectsRepository(executor);

      const result = await repo.createProject({
        id: "prj-001",
        orgId: ORG_ID,
        name: "My Project",
        slug: "my-project",
        slugLower: "my-project",
        createdAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("prj-001");
        expect(result.value.orgId).toBe(ORG_ID);
        expect(result.value.name).toBe("My Project");
        expect(result.value.slugLower).toBe("my-project");
        expect(result.value.status).toBe("active");
        expect(result.value.createdAt).toEqual(NOW);
        expect(result.value.archivedAt).toBeNull();
      }
    });

    it("returns conflict on duplicate project", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createProjectsRepository(executor);

      const result = await repo.createProject({
        id: "prj-001",
        orgId: ORG_ID,
        name: "My Project",
        slug: "my-project",
        slugLower: "my-project",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("conflict");
      }
    });

    it("returns conflict on unique violation error code", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("D1_ERROR: UNIQUE constraint failed"),
      });
      const repo = createProjectsRepository(executor);

      const result = await repo.createProject({
        id: "prj-002",
        orgId: ORG_ID,
        name: "My Project",
        slug: "my-project",
        slugLower: "my-project",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("conflict");
      }
    });

    it("maps generic errors to safe internal error", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("connection to host 10.0.0.1:5432 refused"),
      });
      const repo = createProjectsRepository(executor);

      const result = await repo.createProject({
        id: "prj-001",
        orgId: ORG_ID,
        name: "Test",
        slug: "test",
        slugLower: "test",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal");
        expect((result.error as { kind: "internal"; message: string }).message).not.toContain("10.0.0.1");
      }
    });
  });

  describe("countActiveProjects", () => {
    it("uses parameterized COUNT scoped by org_id and active status", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [{ count: 3 }] });
      const repo = createProjectsRepository(executor);

      await repo.countActiveProjects(ORG_ID);

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("COUNT(*)");
      expect(queries[0]!.text).toContain("projects_projects");
      expect(queries[0]!.text).toContain("org_id = $1");
      expect(queries[0]!.text).toContain("status = 'active'");
      expect(queries[0]!.params).toEqual([ORG_ID]);
    });

    it("returns numeric count when pg returns a number", async () => {
      const { executor } = createFakeExecutor({ rows: [{ count: 7 }] });
      const repo = createProjectsRepository(executor);

      const result = await repo.countActiveProjects(ORG_ID);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(7);
    });

    it("coerces bigint count returned by pg", async () => {
      const { executor } = createFakeExecutor({ rows: [{ count: BigInt(42) }] });
      const repo = createProjectsRepository(executor);

      const result = await repo.countActiveProjects(ORG_ID);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(42);
    });

    it("coerces string count returned by pg (bigint-as-string)", async () => {
      const { executor } = createFakeExecutor({ rows: [{ count: "12" }] });
      const repo = createProjectsRepository(executor);

      const result = await repo.countActiveProjects(ORG_ID);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(12);
    });

    it("returns 0 when no rows", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createProjectsRepository(executor);

      const result = await repo.countActiveProjects(ORG_ID);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(0);
    });

    it("returns safe internal error on executor failure", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("connection to 10.0.0.1:5432 refused"),
      });
      const repo = createProjectsRepository(executor);

      const result = await repo.countActiveProjects(ORG_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal");
        expect(
          (result.error as { kind: "internal"; message: string }).message,
        ).not.toContain("10.0.0.1");
      }
    });

    it("returns safe internal error when count parses to NaN", async () => {
      const { executor } = createFakeExecutor({ rows: [{ count: "not-a-number" }] });
      const repo = createProjectsRepository(executor);

      const result = await repo.countActiveProjects(ORG_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("internal");
    });
  });

  describe("countActiveEnvironments", () => {
    it("uses parameterized COUNT scoped by org_id, project_id, and active status", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [{ count: 3 }] });
      const repo = createProjectsRepository(executor);

      await repo.countActiveEnvironments(ORG_ID, PRJ_ID);

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("COUNT(*)");
      expect(queries[0]!.text).toContain("projects_environments");
      expect(queries[0]!.text).toContain("org_id = $1");
      expect(queries[0]!.text).toContain("project_id = $2");
      expect(queries[0]!.text).toContain("status = 'active'");
      expect(queries[0]!.params).toEqual([ORG_ID, PRJ_ID]);
    });

    it("returns numeric count when pg returns a number", async () => {
      const { executor } = createFakeExecutor({ rows: [{ count: 7 }] });
      const repo = createProjectsRepository(executor);

      const result = await repo.countActiveEnvironments(ORG_ID, PRJ_ID);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(7);
    });

    it("coerces bigint count returned by pg", async () => {
      const { executor } = createFakeExecutor({ rows: [{ count: BigInt(42) }] });
      const repo = createProjectsRepository(executor);

      const result = await repo.countActiveEnvironments(ORG_ID, PRJ_ID);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(42);
    });

    it("coerces string count returned by pg (bigint-as-string)", async () => {
      const { executor } = createFakeExecutor({ rows: [{ count: "12" }] });
      const repo = createProjectsRepository(executor);

      const result = await repo.countActiveEnvironments(ORG_ID, PRJ_ID);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(12);
    });

    it("returns 0 when no rows", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createProjectsRepository(executor);

      const result = await repo.countActiveEnvironments(ORG_ID, PRJ_ID);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(0);
    });

    it("returns safe internal error on executor failure", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("connection to 10.0.0.1:5432 refused"),
      });
      const repo = createProjectsRepository(executor);

      const result = await repo.countActiveEnvironments(ORG_ID, PRJ_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal");
        expect(
          (result.error as { kind: "internal"; message: string }).message,
        ).not.toContain("10.0.0.1");
      }
    });

    it("returns safe internal error when count parses to NaN", async () => {
      const { executor } = createFakeExecutor({ rows: [{ count: "not-a-number" }] });
      const repo = createProjectsRepository(executor);

      const result = await repo.countActiveEnvironments(ORG_ID, PRJ_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("internal");
    });
  });

  describe("getProjectById", () => {
    it("includes org_id and project_id in query params", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_PROJECT_ROW] });
      const repo = createProjectsRepository(executor);

      await repo.getProjectById(ORG_ID, PRJ_ID);

      expect(queries[0]!.params).toEqual([ORG_ID, PRJ_ID]);
      expect(queries[0]!.text).toContain("org_id = $1");
      expect(queries[0]!.text).toContain("id = $2");
    });

    it("returns not_found when no rows", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createProjectsRepository(executor);

      const result = await repo.getProjectById(ORG_ID, asUuid("bbbbbbbb-0001-0001-0001-000000000099"));

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("getProjectBySlug", () => {
    it("scopes slug lookup by org_id", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_PROJECT_ROW] });
      const repo = createProjectsRepository(executor);

      await repo.getProjectBySlug(ORG_ID, "my-project");

      expect(queries[0]!.params).toEqual([ORG_ID, "my-project"]);
      expect(queries[0]!.text).toContain("org_id = $1");
      expect(queries[0]!.text).toContain("slug_lower = $2");
    });

    it("returns not_found for unknown slug", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createProjectsRepository(executor);

      const result = await repo.getProjectBySlug(ORG_ID, "unknown-slug");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("listProjectsPaged", () => {
    it("uses deterministic ordering with limit+1 and org_id scope", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_PROJECT_ROW] });
      const repo = createProjectsRepository(executor);

      await repo.listProjectsPaged(ORG_ID, { limit: 10, cursor: null });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("org_id = $1");
      expect(queries[0]!.text).toContain("ORDER BY");
      expect(queries[0]!.text).toContain("LIMIT");
      expect(queries[0]!.params).toEqual([ORG_ID, 11]);
    });

    it("applies cursor filtering with timestamp and id tie-breaker", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [] });
      const repo = createProjectsRepository(executor);

      await repo.listProjectsPaged(ORG_ID, {
        limit: 5,
        cursor: { createdAt: "2026-01-15T10:00:00.000Z", id: "prj-001" },
      });

      expect(queries[0]!.text).toContain("$3");
      expect(queries[0]!.text).toContain("$4");
      expect(queries[0]!.params).toEqual([ORG_ID, 6, "2026-01-15T10:00:00.000Z", "prj-001"]);
    });

    it("returns nextCursor when more rows exist", async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        ...SAMPLE_PROJECT_ROW,
        id: `prj-${String(i).padStart(3, "0")}`,
        created_at: new Date(NOW.getTime() - i * 1000).toISOString(),
        updated_at: new Date(NOW.getTime() - i * 1000).toISOString(),
      }));
      const { executor } = createFakeExecutor({ rows });
      const repo = createProjectsRepository(executor);

      const result = await repo.listProjectsPaged(ORG_ID, { limit: 2, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(2);
        expect(result.value.nextCursor).not.toBeNull();
        expect(result.value.nextCursor!.id).toBe("prj-001");
      }
    });

    it("returns null nextCursor when no more rows", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_PROJECT_ROW] });
      const repo = createProjectsRepository(executor);

      const result = await repo.listProjectsPaged(ORG_ID, { limit: 10, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(1);
        expect(result.value.nextCursor).toBeNull();
      }
    });

    it("returns empty result safely", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createProjectsRepository(executor);

      const result = await repo.listProjectsPaged(ORG_ID, { limit: 50, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(0);
        expect(result.value.nextCursor).toBeNull();
      }
    });
  });

  describe("archiveProject", () => {
    it("uses parameterized update with status = 'active' guard and org_id scope", async () => {
      const archivedRow = { ...SAMPLE_PROJECT_ROW, status: "archived", archived_at: NOW.toISOString() };
      const { executor, queries } = createFakeExecutor({ rows: [archivedRow] });
      const repo = createProjectsRepository(executor);

      await repo.archiveProject(ORG_ID, PRJ_ID, NOW);

      expect(queries[0]!.text).toContain("org_id = $1");
      expect(queries[0]!.text).toContain("id = $2");
      expect(queries[0]!.text).toContain("status = 'active'");
      expect(queries[0]!.params).toEqual([ORG_ID, PRJ_ID, NOW.toISOString()]);
    });

    it("returns not_found when project already archived or does not exist", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createProjectsRepository(executor);

      const result = await repo.archiveProject(ORG_ID, PRJ_ID, NOW);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });

    it("maps generic errors to safe internal error", async () => {
      const { executor } = createFakeExecutor({ error: new Error("timeout") });
      const repo = createProjectsRepository(executor);

      const result = await repo.archiveProject(ORG_ID, PRJ_ID, NOW);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal");
      }
    });
  });

  describe("createEnvironment", () => {
    it("carries org_id and project_id in parameterized insert", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ENVIRONMENT_ROW] });
      const repo = createProjectsRepository(executor);

      await repo.createEnvironment({
        id: "env-001",
        orgId: ORG_ID,
        projectId: PRJ_ID,
        name: "Production",
        slug: "production",
        slugLower: "production",
        createdAt: NOW,
      });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("$1");
      expect(queries[0]!.text).toContain("$7");
      expect(queries[0]!.params).toEqual([
        "env-001",
        ORG_ID,
        PRJ_ID,
        "Production",
        "production",
        "production",
        NOW.toISOString(),
      ]);
    });

    it("maps returned row to Environment type", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_ENVIRONMENT_ROW] });
      const repo = createProjectsRepository(executor);

      const result = await repo.createEnvironment({
        id: "env-001",
        orgId: ORG_ID,
        projectId: PRJ_ID,
        name: "Production",
        slug: "production",
        slugLower: "production",
        createdAt: NOW,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe("env-001");
        expect(result.value.orgId).toBe(ORG_ID);
        expect(result.value.projectId).toBe("prj-001");
        expect(result.value.name).toBe("Production");
        expect(result.value.archivedAt).toBeNull();
      }
    });

    it("returns conflict on unique violation", async () => {
      const { executor } = createFakeExecutor({
        error: new Error("D1_ERROR: UNIQUE constraint failed"),
      });
      const repo = createProjectsRepository(executor);

      const result = await repo.createEnvironment({
        id: "env-002",
        orgId: ORG_ID,
        projectId: PRJ_ID,
        name: "Production",
        slug: "production",
        slugLower: "production",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("conflict");
    });
  });

  describe("getEnvironmentById", () => {
    it("includes org_id + project_id + environment_id in query params", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ENVIRONMENT_ROW] });
      const repo = createProjectsRepository(executor);

      await repo.getEnvironmentById(ORG_ID, PRJ_ID, "env-001");

      expect(queries[0]!.params).toEqual([ORG_ID, PRJ_ID, "env-001"]);
      expect(queries[0]!.text).toContain("org_id = $1");
      expect(queries[0]!.text).toContain("project_id = $2");
      expect(queries[0]!.text).toContain("id = $3");
    });

    it("returns not_found when no rows", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createProjectsRepository(executor);

      const result = await repo.getEnvironmentById(ORG_ID, PRJ_ID, "env-missing");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("getEnvironmentBySlug", () => {
    it("scopes slug lookup by org_id + project_id", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ENVIRONMENT_ROW] });
      const repo = createProjectsRepository(executor);

      await repo.getEnvironmentBySlug(ORG_ID, PRJ_ID, "production");

      expect(queries[0]!.params).toEqual([ORG_ID, PRJ_ID, "production"]);
      expect(queries[0]!.text).toContain("org_id = $1");
      expect(queries[0]!.text).toContain("project_id = $2");
      expect(queries[0]!.text).toContain("slug_lower = $3");
    });

    it("returns not_found for unknown slug", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createProjectsRepository(executor);

      const result = await repo.getEnvironmentBySlug(ORG_ID, PRJ_ID, "unknown");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });
  });

  describe("listEnvironmentsPaged", () => {
    it("includes org_id + project_id and uses deterministic ordering", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_ENVIRONMENT_ROW] });
      const repo = createProjectsRepository(executor);

      await repo.listEnvironmentsPaged(ORG_ID, PRJ_ID, { limit: 10, cursor: null });

      expect(queries).toHaveLength(1);
      expect(queries[0]!.text).toContain("org_id = $1");
      expect(queries[0]!.text).toContain("project_id = $2");
      expect(queries[0]!.text).toContain("ORDER BY");
      expect(queries[0]!.text).toContain("LIMIT");
      expect(queries[0]!.params).toEqual([ORG_ID, PRJ_ID, 11]);
    });

    it("applies cursor filtering with timestamp and id tie-breaker", async () => {
      const { executor, queries } = createFakeExecutor({ rows: [] });
      const repo = createProjectsRepository(executor);

      await repo.listEnvironmentsPaged(ORG_ID, PRJ_ID, {
        limit: 5,
        cursor: { createdAt: "2026-01-15T10:00:00.000Z", id: "env-001" },
      });

      expect(queries[0]!.text).toContain("$4");
      expect(queries[0]!.text).toContain("$5");
      expect(queries[0]!.params).toEqual([ORG_ID, PRJ_ID, 6, "2026-01-15T10:00:00.000Z", "env-001"]);
    });

    it("returns nextCursor when more rows exist", async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({
        ...SAMPLE_ENVIRONMENT_ROW,
        id: `env-${String(i).padStart(3, "0")}`,
        created_at: new Date(NOW.getTime() - i * 1000).toISOString(),
        updated_at: new Date(NOW.getTime() - i * 1000).toISOString(),
      }));
      const { executor } = createFakeExecutor({ rows });
      const repo = createProjectsRepository(executor);

      const result = await repo.listEnvironmentsPaged(ORG_ID, PRJ_ID, { limit: 2, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(2);
        expect(result.value.nextCursor).not.toBeNull();
        expect(result.value.nextCursor!.id).toBe("env-001");
      }
    });

    it("returns null nextCursor when no more rows", async () => {
      const { executor } = createFakeExecutor({ rows: [SAMPLE_ENVIRONMENT_ROW] });
      const repo = createProjectsRepository(executor);

      const result = await repo.listEnvironmentsPaged(ORG_ID, PRJ_ID, { limit: 10, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(1);
        expect(result.value.nextCursor).toBeNull();
      }
    });

    it("returns empty result safely", async () => {
      const { executor } = createFakeExecutor({ rows: [] });
      const repo = createProjectsRepository(executor);

      const result = await repo.listEnvironmentsPaged(ORG_ID, PRJ_ID, { limit: 50, cursor: null });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items).toHaveLength(0);
        expect(result.value.nextCursor).toBeNull();
      }
    });
  });

  describe("archiveEnvironment", () => {
    it("uses parameterized update with org_id + project_id + id and active guard", async () => {
      const archivedRow = { ...SAMPLE_ENVIRONMENT_ROW, status: "archived", archived_at: NOW.toISOString() };
      const { executor, queries } = createFakeExecutor({ rows: [archivedRow] });
      const repo = createProjectsRepository(executor);

      await repo.archiveEnvironment(ORG_ID, PRJ_ID, "env-001", NOW);

      expect(queries[0]!.text).toContain("org_id = $1");
      expect(queries[0]!.text).toContain("project_id = $2");
      expect(queries[0]!.text).toContain("id = $3");
      expect(queries[0]!.text).toContain("status = 'active'");
      expect(queries[0]!.params).toEqual([ORG_ID, PRJ_ID, "env-001", NOW.toISOString()]);
    });

    it("returns not_found when environment already archived", async () => {
      const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
      const repo = createProjectsRepository(executor);

      const result = await repo.archiveEnvironment(ORG_ID, PRJ_ID, "env-001", NOW);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("not_found");
    });

    it("maps generic errors to safe internal error", async () => {
      const { executor } = createFakeExecutor({ error: new Error("connection refused") });
      const repo = createProjectsRepository(executor);

      const result = await repo.archiveEnvironment(ORG_ID, PRJ_ID, "env-001", NOW);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("internal");
        expect((result.error as { kind: "internal"; message: string }).message).not.toContain("connection refused");
      }
    });
  });

  describe("safe error handling", () => {
    it("never exposes raw SQL errors in repository outputs", async () => {
      const pgError = new Error(
        'relation "projects_projects" does not exist at character 15',
      );
      const { executor } = createFakeExecutor({ error: pgError });
      const repo = createProjectsRepository(executor);

      const result = await repo.getProjectById(ORG_ID, PRJ_ID);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "internal") {
        expect(result.error.message).not.toContain("relation");
        expect(result.error.message).not.toContain("character 15");
      }
    });

    it("never exposes connection strings in errors", async () => {
      const connError = new Error(
        "could not connect to postgres://admin:secret@db.internal:5432/prod",
      );
      const { executor } = createFakeExecutor({ error: connError });
      const repo = createProjectsRepository(executor);

      const result = await repo.createProject({
        id: "prj-001",
        orgId: ORG_ID,
        name: "Test",
        slug: "test",
        slugLower: "test",
        createdAt: NOW,
      });

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "internal") {
        expect(result.error.message).not.toContain("admin");
        expect(result.error.message).not.toContain("secret");
        expect(result.error.message).not.toContain("db.internal");
      }
    });
  });

  describe("Worker-safe import isolation", () => {
    it("does not import runner-only modules", async () => {
      const mod = await import("@saas/db/projects");
      const exportKeys = Object.keys(mod);

      expect(exportKeys).toContain("createProjectsRepository");
      expect(exportKeys).not.toContain("runMigrations");
      expect(exportKeys).not.toContain("D1ApiAdapter");
      expect(exportKeys).not.toContain("loadD1CredentialsFromEnv");
    });
  });
});
