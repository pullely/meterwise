-- 040_projects_core
-- Projects persistence foundation — projects and environments tables
-- Bounded context: projects
-- schema projects: Projects bounded context — owns project and environment persistence.

-- Projects table: one project belongs to exactly one organization.
CREATE TABLE IF NOT EXISTS projects_projects (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  slug_lower  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT
);

-- table projects_projects: Projects within an organization. Every query must scope by org_id.
-- column projects_projects.org_id: Owning organization — opaque reference, no cross-context FK.
-- column projects_projects.slug_lower: Lowercased slug for case-insensitive uniqueness within org.

-- Unique slug per organization (case-insensitive via slug_lower)
CREATE UNIQUE INDEX IF NOT EXISTS projects_org_slug_lower_idx
  ON projects_projects (org_id, slug_lower);

-- Composite unique for FK target from environments
CREATE UNIQUE INDEX IF NOT EXISTS projects_org_id_id_idx
  ON projects_projects (org_id, id);

-- List projects by org, newest first with id tie-breaker
CREATE INDEX IF NOT EXISTS projects_org_created_idx
  ON projects_projects (org_id, created_at DESC, id DESC);

-- Environments table: one environment belongs to exactly one project and organization.
CREATE TABLE IF NOT EXISTS projects_environments (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  slug_lower  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT,
  FOREIGN KEY (org_id, project_id) REFERENCES projects_projects (org_id, id)
);

-- table projects_environments: Environments within a project. Every query must scope by org_id + project_id.
-- column projects_environments.org_id: Owning organization — denormalized for tenant isolation.
-- column projects_environments.project_id: Owning project — same bounded context FK.
-- column projects_environments.slug_lower: Lowercased slug for case-insensitive uniqueness within org+project.

-- Unique slug per org + project (case-insensitive via slug_lower)
CREATE UNIQUE INDEX IF NOT EXISTS environments_org_project_slug_lower_idx
  ON projects_environments (org_id, project_id, slug_lower);

-- List environments by org + project, newest first with id tie-breaker
CREATE INDEX IF NOT EXISTS environments_org_project_created_idx
  ON projects_environments (org_id, project_id, created_at DESC, id DESC);
