-- Membership persistence foundation.
-- Context: membership
-- Idempotent: uses IF NOT EXISTS throughout.
-- schema membership: Membership bounded context — owns organizations, members, invitations, and role assignments.

-- Organizations: the root tenant boundary.
CREATE TABLE IF NOT EXISTS membership_organizations (
  id            TEXT        PRIMARY KEY,
  name          TEXT        NOT NULL,
  slug          TEXT        NOT NULL,
  slug_lower    TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT organizations_status_check CHECK (status IN ('active', 'suspended', 'deleted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_lower_idx
  ON membership_organizations (slug_lower);

-- table membership_organizations: Root organization records — the tenant and billing boundary.
-- column membership_organizations.slug_lower: Normalized (lower-case) slug for case-insensitive uniqueness.

-- Organization members: connects a subject to an organization.
CREATE TABLE IF NOT EXISTS membership_organization_members (
  id              TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL,
  subject_id      TEXT        NOT NULL,
  subject_type    TEXT        NOT NULL DEFAULT 'user',
  status          TEXT        NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT org_members_status_check CHECK (status IN ('active', 'removed')),
  CONSTRAINT org_members_subject_type_check CHECK (subject_type IN ('user', 'service_principal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS org_members_org_subject_idx
  ON membership_organization_members (org_id, subject_id);

CREATE INDEX IF NOT EXISTS org_members_subject_id_idx
  ON membership_organization_members (subject_id);

CREATE INDEX IF NOT EXISTS org_members_org_id_idx
  ON membership_organization_members (org_id);

-- table membership_organization_members: Membership facts connecting subjects to organizations. Subject references are opaque IDs.
-- column membership_organization_members.subject_id: Opaque subject ID from the identity or service-principal context.
-- column membership_organization_members.org_id: The organization this membership belongs to.

-- Organization invitations: invitation lifecycle records.
CREATE TABLE IF NOT EXISTS membership_organization_invitations (
  id              TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL,
  email           TEXT        NOT NULL,
  email_lower     TEXT        NOT NULL,
  role            TEXT        NOT NULL,
  token_hash      TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending',
  invited_by      TEXT        NOT NULL,
  expires_at      TEXT NOT NULL,
  accepted_at     TEXT,
  revoked_at      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CONSTRAINT org_invitations_status_check CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  CONSTRAINT org_invitations_role_check CHECK (role IN (
    'owner', 'admin', 'builder', 'viewer', 'billing_admin',
    'project_admin', 'project_builder', 'project_viewer'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS org_invitations_token_hash_idx
  ON membership_organization_invitations (token_hash);

CREATE INDEX IF NOT EXISTS org_invitations_org_id_idx
  ON membership_organization_invitations (org_id);

CREATE INDEX IF NOT EXISTS org_invitations_email_lower_idx
  ON membership_organization_invitations (org_id, email_lower);

-- table membership_organization_invitations: Invitation lifecycle records. Only token hashes stored, never raw tokens.
-- column membership_organization_invitations.token_hash: SHA-256 hash of the invitation acceptance token. Raw token never stored.
-- column membership_organization_invitations.email_lower: Normalized (lower-case) email for case-insensitive lookup.

-- Role assignments: authorization facts consumed by the policy context.
CREATE TABLE IF NOT EXISTS membership_role_assignments (
  id              TEXT        PRIMARY KEY,
  org_id          TEXT        NOT NULL,
  subject_id      TEXT        NOT NULL,
  subject_type    TEXT        NOT NULL DEFAULT 'user',
  role            TEXT        NOT NULL,
  scope_kind      TEXT        NOT NULL DEFAULT 'organization',
  scope_ref       TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at      TEXT,

  CONSTRAINT role_assignments_role_check CHECK (role IN (
    'owner', 'admin', 'builder', 'viewer', 'billing_admin',
    'project_admin', 'project_builder', 'project_viewer'
  )),
  CONSTRAINT role_assignments_scope_kind_check CHECK (scope_kind IN ('organization', 'project')),
  CONSTRAINT role_assignments_subject_type_check CHECK (subject_type IN ('user', 'service_principal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS role_assignments_active_idx
  ON membership_role_assignments (org_id, subject_id, role, scope_kind, COALESCE(scope_ref, ''))
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS role_assignments_org_subject_idx
  ON membership_role_assignments (org_id, subject_id);

CREATE INDEX IF NOT EXISTS role_assignments_subject_id_idx
  ON membership_role_assignments (subject_id);

-- table membership_role_assignments: Authorization facts consumed by the policy context. Scoped to organization or project.
-- column membership_role_assignments.subject_id: Opaque subject ID — no foreign key to identity context.
-- column membership_role_assignments.scope_kind: organization or project — determines the scope of the role.
-- column membership_role_assignments.scope_ref: Optional project reference for project-scoped roles. NULL for organization-scoped.
