import type {
  PublicProject,
  CreateProjectRequest,
  CreateProjectResponse,
  GetProjectResponse,
  ListProjectsResponse,
  ArchiveProjectResponse,
  PublicEnvironment,
  CreateEnvironmentRequest,
  CreateEnvironmentResponse,
  GetEnvironmentResponse,
  ListEnvironmentsResponse,
  ArchiveEnvironmentResponse,
} from "@saas/contracts/projects";

describe("contracts: project types", () => {
  it("PublicProject shape includes orgId and status fields", () => {
    const project: PublicProject = {
      id: "prj_001",
      orgId: "org_001",
      name: "My Project",
      slug: "my-project",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archivedAt: null,
    };
    expect(project.orgId).toBe("org_001");
    expect(project.status).toBe("active");
    expect(project.archivedAt).toBeNull();
  });

  it("CreateProjectRequest accepts name and optional slug", () => {
    const req: CreateProjectRequest = { name: "New Project" };
    expect(req.name).toBe("New Project");
    expect(req.slug).toBeUndefined();

    const reqWithSlug: CreateProjectRequest = { name: "Proj", slug: "proj" };
    expect(reqWithSlug.slug).toBe("proj");
  });

  it("CreateProjectResponse wraps a PublicProject", () => {
    const res: CreateProjectResponse = {
      project: {
        id: "prj_001",
        orgId: "org_001",
        name: "Test",
        slug: "test",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        archivedAt: null,
      },
    };
    expect(res.project.id).toBe("prj_001");
  });

  it("GetProjectResponse wraps a PublicProject", () => {
    const res: GetProjectResponse = {
      project: {
        id: "prj_001",
        orgId: "org_001",
        name: "Test",
        slug: "test",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        archivedAt: null,
      },
    };
    expect(res.project.orgId).toBe("org_001");
  });

  it("ListProjectsResponse contains an array of PublicProject", () => {
    const res: ListProjectsResponse = { projects: [] };
    expect(res.projects).toEqual([]);
  });

  it("ArchiveProjectResponse includes archivedAt timestamp", () => {
    const res: ArchiveProjectResponse = {
      project: {
        id: "prj_001",
        orgId: "org_001",
        name: "Archived",
        slug: "archived",
        status: "archived",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
        archivedAt: "2026-02-01T00:00:00Z",
      },
    };
    expect(res.project.status).toBe("archived");
    expect(res.project.archivedAt).toBe("2026-02-01T00:00:00Z");
  });
});

describe("contracts: environment types", () => {
  it("PublicEnvironment shape includes orgId and projectId", () => {
    const env: PublicEnvironment = {
      id: "env_001",
      orgId: "org_001",
      projectId: "prj_001",
      name: "Production",
      slug: "production",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archivedAt: null,
    };
    expect(env.orgId).toBe("org_001");
    expect(env.projectId).toBe("prj_001");
  });

  it("CreateEnvironmentRequest accepts name and optional slug", () => {
    const req: CreateEnvironmentRequest = { name: "Staging" };
    expect(req.name).toBe("Staging");
    expect(req.slug).toBeUndefined();
  });

  it("CreateEnvironmentResponse wraps a PublicEnvironment", () => {
    const res: CreateEnvironmentResponse = {
      environment: {
        id: "env_001",
        orgId: "org_001",
        projectId: "prj_001",
        name: "Staging",
        slug: "staging",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        archivedAt: null,
      },
    };
    expect(res.environment.projectId).toBe("prj_001");
  });

  it("GetEnvironmentResponse wraps a PublicEnvironment", () => {
    const res: GetEnvironmentResponse = {
      environment: {
        id: "env_001",
        orgId: "org_001",
        projectId: "prj_001",
        name: "Test",
        slug: "test",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        archivedAt: null,
      },
    };
    expect(res.environment.orgId).toBe("org_001");
  });

  it("ListEnvironmentsResponse contains an array of PublicEnvironment", () => {
    const res: ListEnvironmentsResponse = { environments: [] };
    expect(res.environments).toEqual([]);
  });

  it("ArchiveEnvironmentResponse includes archivedAt timestamp", () => {
    const res: ArchiveEnvironmentResponse = {
      environment: {
        id: "env_001",
        orgId: "org_001",
        projectId: "prj_001",
        name: "Archived",
        slug: "archived",
        status: "archived",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
        archivedAt: "2026-02-01T00:00:00Z",
      },
    };
    expect(res.environment.status).toBe("archived");
    expect(res.environment.archivedAt).toBe("2026-02-01T00:00:00Z");
  });
});
