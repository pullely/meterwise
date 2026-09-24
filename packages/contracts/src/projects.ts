export interface PublicProject {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateProjectRequest {
  name: string;
  slug?: string;
}

export interface CreateProjectResponse {
  project: PublicProject;
}

export interface GetProjectResponse {
  project: PublicProject;
}

export interface ListProjectsResponse {
  projects: PublicProject[];
}

export interface ArchiveProjectResponse {
  project: PublicProject;
}

export interface PublicEnvironment {
  id: string;
  orgId: string;
  projectId: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CreateEnvironmentRequest {
  name: string;
  slug?: string;
}

export interface CreateEnvironmentResponse {
  environment: PublicEnvironment;
}

export interface GetEnvironmentResponse {
  environment: PublicEnvironment;
}

export interface ListEnvironmentsResponse {
  environments: PublicEnvironment[];
}

export interface ArchiveEnvironmentResponse {
  environment: PublicEnvironment;
}
