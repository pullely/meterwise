import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleCreateProject } from "./handlers/create-project.js";
import { handleGetProject } from "./handlers/get-project.js";
import { handleListProjects } from "./handlers/list-projects.js";
import { handleArchiveProject } from "./handlers/archive-project.js";
import { handleCreateEnvironment } from "./handlers/create-environment.js";
import { handleListEnvironments } from "./handlers/list-environments.js";
import { handleInternalListEnvironments } from "./handlers/internal-environments.js";
import { handleGetEnvironment } from "./handlers/get-environment.js";
import { handleArchiveEnvironment } from "./handlers/archive-environment.js";
import { errorResponse, notFound, methodNotAllowed } from "./http.js";
import { generateRequestId, parseOrgPublicId, parseProjectPublicId, parseEnvironmentPublicId } from "./ids.js";

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

const ORG_PROJECTS_RE = /^\/v1\/organizations\/([^/]+)\/projects$/;
const ORG_PROJECT_ID_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)$/;
const ORG_PROJECT_ENVIRONMENTS_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments$/;
const ORG_PROJECT_ENVIRONMENT_ID_RE = /^\/v1\/organizations\/([^/]+)\/projects\/([^/]+)\/environments\/([^/]+)$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    // Internal worker-to-worker seam (service-binding-only; never edge-routed).
    if (url.pathname === "/v1/internal/projects/environments") {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleInternalListEnvironments(request, env, requestId);
    }

    const envIdMatch = url.pathname.match(ORG_PROJECT_ENVIRONMENT_ID_RE);
    if (envIdMatch) {
      const orgPublicId = envIdMatch[1]!;
      const projectPublicIdStr = envIdMatch[2]!;
      const envPublicId = envIdMatch[3]!;
      const orgUuid = parseOrgPublicId(orgPublicId);
      const projectUuid = parseProjectPublicId(projectPublicIdStr);
      const envUuid = parseEnvironmentPublicId(envPublicId);
      if (!orgUuid || !projectUuid || !envUuid) {
        return errorResponse("not_found", "Not found", 404, requestId);
      }

      if (request.method === "GET") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleGetEnvironment(env, requestId, actor, orgUuid, projectUuid, envUuid);
      }
      if (request.method === "DELETE") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleArchiveEnvironment(env, requestId, actor, orgUuid, projectUuid, envUuid);
      }
      return methodNotAllowed(requestId);
    }

    const envsMatch = url.pathname.match(ORG_PROJECT_ENVIRONMENTS_RE);
    if (envsMatch) {
      const orgPublicId = envsMatch[1]!;
      const projectPublicIdStr = envsMatch[2]!;
      const orgUuid = parseOrgPublicId(orgPublicId);
      const projectUuid = parseProjectPublicId(projectPublicIdStr);
      if (!orgUuid || !projectUuid) {
        return errorResponse("not_found", "Not found", 404, requestId);
      }

      if (request.method === "POST") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleCreateEnvironment(request, env, requestId, actor, orgUuid, projectUuid);
      }
      if (request.method === "GET") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleListEnvironments(request, env, requestId, actor, orgUuid, projectUuid);
      }
      return methodNotAllowed(requestId);
    }

    const projectsMatch = url.pathname.match(ORG_PROJECTS_RE);
    if (projectsMatch) {
      const orgPublicId = projectsMatch[1]!;
      const orgUuid = parseOrgPublicId(orgPublicId);
      if (!orgUuid) {
        return errorResponse("not_found", "Not found", 404, requestId);
      }

      if (request.method === "POST") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleCreateProject(request, env, requestId, actor, orgUuid);
      }
      if (request.method === "GET") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleListProjects(request, env, requestId, actor, orgUuid);
      }
      return methodNotAllowed(requestId);
    }

    const projectIdMatch = url.pathname.match(ORG_PROJECT_ID_RE);
    if (projectIdMatch) {
      const orgPublicId = projectIdMatch[1]!;
      const projectPublicId = projectIdMatch[2]!;
      const orgUuid = parseOrgPublicId(orgPublicId);
      const projectUuid = parseProjectPublicId(projectPublicId);
      if (!orgUuid || !projectUuid) {
        return errorResponse("not_found", "Not found", 404, requestId);
      }

      if (request.method === "GET") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleGetProject(env, requestId, actor, orgUuid, projectUuid);
      }
      if (request.method === "DELETE") {
        const actor = resolveActor(request);
        if (!actor) {
          return errorResponse("unauthenticated", "Authentication required", 401, requestId);
        }
        return handleArchiveProject(env, requestId, actor, orgUuid, projectUuid);
      }
      return methodNotAllowed(requestId);
    }

    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
