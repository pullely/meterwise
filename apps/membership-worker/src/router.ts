import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleCreateOrganization } from "./handlers/create-organization.js";
import { handleListOrganizations } from "./handlers/list-organizations.js";
import { handleGetOrganization } from "./handlers/get-organization.js";
import { handleListMembers } from "./handlers/list-members.js";
import { handleUpdateMemberRole } from "./handlers/update-member-role.js";
import { handleRemoveMember } from "./handlers/remove-member.js";
import { handleCreateInvitation } from "./handlers/create-invitation.js";
import { handleListInvitations } from "./handlers/list-invitations.js";
import { handleRevokeInvitation } from "./handlers/revoke-invitation.js";
import { handleAcceptInvitation } from "./handlers/accept-invitation.js";
import { handleAuthorizationContext } from "./handlers/authorization-context.js";
import { handleSyncAccountChildren } from "./handlers/sync-account-children.js";
import { handleResolveBillingParent } from "./handlers/resolve-billing-parent.js";
import { handleCreateServicePrincipalBinding, handleListServicePrincipalBindings, handleRevokeServicePrincipalBinding } from "./handlers/service-principal-bindings.js";
import { errorResponse, notFound, methodNotAllowed } from "./http.js";
import { generateRequestId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

const ORG_ID_RE = /^\/v1\/organizations\/([^/]+)$/;
const ORG_MEMBERS_RE = /^\/v1\/organizations\/([^/]+)\/members$/;
const ORG_MEMBER_ID_RE = /^\/v1\/organizations\/([^/]+)\/members\/([^/]+)$/;
const ORG_INVITATIONS_ACCEPT_RE = /^\/v1\/organizations\/([^/]+)\/invitations\/accept$/;
const ORG_INVITATIONS_RE = /^\/v1\/organizations\/([^/]+)\/invitations$/;
const ORG_INVITATION_ID_RE = /^\/v1\/organizations\/([^/]+)\/invitations\/([^/]+)$/;
const SP_BINDINGS_PATH = "/v1/internal/membership/service-principal-bindings";
const SP_BINDING_ID_RE = /^\/v1\/internal\/membership\/service-principal-bindings\/([^/]+)$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    if (url.pathname === "/v1/internal/membership/authorization-context") {
      if (request.method === "POST") {
        return handleAuthorizationContext(request, env, requestId);
      }
      return methodNotAllowed(requestId);
    }

    // Internal child re-sync (MO3): billing-worker calls this after a billing
    // parent's plan changes to re-fan-out (upgrade) or freeze (downgrade) its
    // children. Service-binding only — not routed by api-edge.
    if (url.pathname === "/v1/internal/membership/account/children-sync") {
      if (request.method === "POST") {
        return handleSyncAccountChildren(request, env, requestId);
      }
      return methodNotAllowed(requestId);
    }

    // Internal billing-parent resolution (MO4): billing-worker resolves a child
    // org to the parent whose subscription covers it. Service-binding only.
    if (url.pathname === "/v1/internal/membership/organizations/billing-parent") {
      if (request.method === "POST") {
        return handleResolveBillingParent(request, env, requestId);
      }
      return methodNotAllowed(requestId);
    }

    // Internal service-principal binding routes
    const spBindingIdMatch = url.pathname.match(SP_BINDING_ID_RE);
    if (spBindingIdMatch) {
      if (request.method === "DELETE") {
        return handleRevokeServicePrincipalBinding(env, requestId, spBindingIdMatch[1]!, url);
      }
      return methodNotAllowed(requestId);
    }

    if (url.pathname === SP_BINDINGS_PATH) {
      if (request.method === "POST") {
        return handleCreateServicePrincipalBinding(request, env, requestId);
      }
      if (request.method === "GET") {
        return handleListServicePrincipalBindings(env, requestId, url);
      }
      return methodNotAllowed(requestId);
    }

    if (url.pathname === "/v1/organizations") {
      if (request.method === "POST") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleCreateOrganization(request, env, requestId, actor);
      }
      if (request.method === "GET") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleListOrganizations(env, requestId, actor, url);
      }
      return methodNotAllowed(requestId);
    }

    const acceptMatch = url.pathname.match(ORG_INVITATIONS_ACCEPT_RE);
    if (acceptMatch) {
      if (request.method === "POST") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        const actorEmail = request.headers.get("x-actor-email");
        if (!actorEmail) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleAcceptInvitation(request, env, requestId, { ...actor, email: actorEmail }, acceptMatch[1]!);
      }
      return methodNotAllowed(requestId);
    }

    const invitationIdMatch = url.pathname.match(ORG_INVITATION_ID_RE);
    if (invitationIdMatch) {
      if (request.method === "DELETE") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleRevokeInvitation(env, requestId, actor, invitationIdMatch[1]!, invitationIdMatch[2]!);
      }
      return methodNotAllowed(requestId);
    }

    const invitationsMatch = url.pathname.match(ORG_INVITATIONS_RE);
    if (invitationsMatch) {
      if (request.method === "POST") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleCreateInvitation(request, env, requestId, actor, invitationsMatch[1]!);
      }
      if (request.method === "GET") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleListInvitations(env, requestId, actor, invitationsMatch[1]!, url);
      }
      return methodNotAllowed(requestId);
    }

    const orgMembersMatch = url.pathname.match(ORG_MEMBERS_RE);
    if (orgMembersMatch) {
      if (request.method === "GET") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleListMembers(env, requestId, actor, orgMembersMatch[1]!, url);
      }
      return methodNotAllowed(requestId);
    }

    const memberIdMatch = url.pathname.match(ORG_MEMBER_ID_RE);
    if (memberIdMatch) {
      const actor = resolveActor(request);
      if (!actor) {
        return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      }
      if (request.method === "PATCH") {
        return handleUpdateMemberRole(request, env, requestId, actor, memberIdMatch[1]!, memberIdMatch[2]!);
      }
      if (request.method === "DELETE") {
        return handleRemoveMember(env, requestId, actor, memberIdMatch[1]!, memberIdMatch[2]!);
      }
      return methodNotAllowed(requestId);
    }

    const orgMatch = url.pathname.match(ORG_ID_RE);
    if (orgMatch) {
      if (request.method === "GET") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleGetOrganization(env, requestId, actor, orgMatch[1]!);
      }
      return methodNotAllowed(requestId);
    }

    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
