import type { Uuid } from "../ids/index.js";

export type { SqlExecutor, SqlExecutorResult, SqlRow } from "../d1/executor.js";

export type MembershipRepositoryError =
  | { kind: "not_found" }
  | { kind: "conflict"; entity: string }
  | { kind: "expired" }
  | { kind: "revoked" }
  | { kind: "already_accepted" }
  | { kind: "removed" }
  | { kind: "internal"; message: string };

export type MembershipResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MembershipRepositoryError };

export interface Organization {
  id: string;
  name: string;
  slug: string;
  slugLower: string;
  status: string;
  /**
   * Optional billing parent (epic `saas-multi-org-billing`, MO1). When set, this
   * organization rolls its billing up to the referenced (default/parent) org;
   * NULL means standalone (bills for itself) — the case for every existing org.
   * Resolve with `effectiveBillingOrgId`.
   */
  parentOrgId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationMember {
  id: string;
  orgId: string;
  subjectId: string;
  subjectType: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationInvitation {
  id: string;
  orgId: string;
  email: string;
  emailLower: string;
  role: string;
  status: string;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface RoleAssignment {
  id: string;
  orgId: string;
  subjectId: string;
  subjectType: string;
  role: string;
  scopeKind: string;
  scopeRef: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface CreateOrganizationInput {
  id: string;
  name: string;
  slug: string;
  slugLower: string;
  /** Optional billing parent (MO3). NULL/absent = standalone org. */
  parentOrgId?: string | null;
  createdAt: Date;
}

export interface CreateOrganizationMemberInput {
  id: string;
  orgId: Uuid;
  subjectId: string;
  subjectType: string;
  createdAt: Date;
}

export interface CreateInvitationInput {
  id: string;
  orgId: Uuid;
  email: string;
  emailLower: string;
  role: string;
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateRoleAssignmentInput {
  id: string;
  orgId: Uuid;
  subjectId: string;
  subjectType: string;
  role: string;
  scopeKind: string;
  scopeRef?: string | null;
  createdAt: Date;
}

export interface BootstrapOrganizationInput {
  org: CreateOrganizationInput;
  member: CreateOrganizationMemberInput;
  roleAssignment: CreateRoleAssignmentInput;
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

export interface AcceptInvitationInput {
  tokenHash: string;
  orgId: Uuid;
  emailLower: string;
  memberId: string;
  roleAssignmentId: string;
  subjectId: string;
  subjectType: string;
  acceptedAt: Date;
}

export interface MembershipRepository {
  createOrganization(input: CreateOrganizationInput): Promise<MembershipResult<Organization>>;
  getOrganizationById(id: string): Promise<MembershipResult<Organization>>;
  getOrganizationBySlug(slugLower: string): Promise<MembershipResult<Organization>>;
  /** Child orgs whose billing parent is `parentOrgId` (MO3), oldest first. */
  listChildOrganizations(parentOrgId: string): Promise<MembershipResult<Organization[]>>;
  /** Set an org's lifecycle status (e.g. freeze a child to 'suspended', MO3). */
  setOrganizationStatus(orgId: string, status: string, updatedAt: Date): Promise<MembershipResult<Organization>>;
  listOrganizationsForSubject(subjectId: string): Promise<MembershipResult<Organization[]>>;
  listOrganizationsForSubjectPaged(subjectId: string, params: PageQueryParams): Promise<MembershipResult<PagedResult<Organization>>>;

  bootstrapOrganization(input: BootstrapOrganizationInput): Promise<MembershipResult<{ org: Organization; member: OrganizationMember; roleAssignment: RoleAssignment }>>;

  createMember(input: CreateOrganizationMemberInput): Promise<MembershipResult<OrganizationMember>>;
  getMemberById(orgId: Uuid, memberId: string): Promise<MembershipResult<OrganizationMember>>;
  listMembers(orgId: Uuid): Promise<MembershipResult<OrganizationMember[]>>;
  listMembersPaged(orgId: Uuid, params: PageQueryParams): Promise<MembershipResult<PagedResult<OrganizationMember>>>;
  removeMember(orgId: Uuid, memberId: string, updatedAt: Date): Promise<MembershipResult<OrganizationMember>>;

  createInvitation(input: CreateInvitationInput): Promise<MembershipResult<OrganizationInvitation>>;
  getInvitationById(orgId: Uuid, invitationId: string): Promise<MembershipResult<OrganizationInvitation>>;
  getInvitationByTokenHash(tokenHash: string): Promise<MembershipResult<OrganizationInvitation>>;
  listInvitations(orgId: Uuid): Promise<MembershipResult<OrganizationInvitation[]>>;
  listInvitationsPaged(orgId: Uuid, params: PageQueryParams): Promise<MembershipResult<PagedResult<OrganizationInvitation>>>;
  revokeInvitation(orgId: Uuid, invitationId: string, revokedAt: Date): Promise<MembershipResult<OrganizationInvitation>>;
  acceptInvitation(input: AcceptInvitationInput): Promise<MembershipResult<{ invitation: OrganizationInvitation; member: OrganizationMember; roleAssignment: RoleAssignment }>>;

  createRoleAssignment(input: CreateRoleAssignmentInput): Promise<MembershipResult<RoleAssignment>>;
  listRoleAssignments(orgId: Uuid, subjectId: string): Promise<MembershipResult<RoleAssignment[]>>;
  /**
   * Batched reverse lookup: all active role assignments for a set of subjects in
   * one query, returned as a `subjectId -> RoleAssignment[]` map (every queried
   * subject is present, possibly empty). Avoids the per-member N+1 in member
   * listing (PERF3 / task 0132). Optional so callers/fakes degrade gracefully to
   * per-subject `listRoleAssignments`; the live repository always implements it.
   */
  listRoleAssignmentsForSubjects?(orgId: Uuid, subjectIds: string[]): Promise<MembershipResult<Map<string, RoleAssignment[]>>>;
  revokeRoleAssignment(orgId: Uuid, assignmentId: string, revokedAt: Date): Promise<MembershipResult<RoleAssignment>>;
  revokeAllRoleAssignments(orgId: Uuid, subjectId: string, revokedAt: Date): Promise<MembershipResult<RoleAssignment[]>>;
  countActiveOwners(orgId: Uuid): Promise<MembershipResult<number>>;

  /**
   * Counts billable members for an organization for the purposes of the
   * `limit.members` billing entitlement. The count includes:
   *   - active organization members (membership_organization_members.status = 'active'); and
   *   - pending invitations whose `expires_at > now` and that have neither
   *     been accepted nor revoked.
   *
   * Accepted invitations are not counted here because accepting an invitation
   * already inserts an `organization_members` row and the active member is
   * counted via the first clause; counting the accepted invitation again
   * would double-count.
   *
   * Revoked invitations and expired pending invitations are excluded so
   * that revoking or letting an invite expire frees a seat back up.
   *
   * The helper performs the count in a single parameterized SQL statement
   * to avoid paging entire tables for billing decisions.
   */
  countBillableMembers(orgId: Uuid, now: Date): Promise<MembershipResult<number>>;
}
