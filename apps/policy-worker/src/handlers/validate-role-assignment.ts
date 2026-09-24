import type { RoleAssignmentValidationRequest } from "@saas/contracts/policy";
import { validateRoleAssignment } from "@saas/policy-engine";
import { successResponse, errorResponse, validationError } from "../http.js";

export async function handleValidateRoleAssignment(
  request: Request,
  requestId: string,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  }

  const validation = validateBody(body);
  if (validation) {
    return validationError(requestId, validation);
  }

  const input = body as RoleAssignmentValidationRequest;
  const result = validateRoleAssignment(input);

  return successResponse(result, requestId);
}

function validateBody(body: unknown): Record<string, string[]> | null {
  if (!body || typeof body !== "object") {
    return { body: ["must be an object"] };
  }

  const errors: Record<string, string[]> = {};
  const b = body as Record<string, unknown>;

  if (!b.role || typeof b.role !== "string") {
    errors.role = ["must be a string"];
  }

  if (!b.scope || typeof b.scope !== "object") {
    errors.scope = ["must be an object with kind and orgId"];
  } else {
    const s = b.scope as Record<string, unknown>;
    if (!s.kind || typeof s.kind !== "string") {
      errors["scope.kind"] = ["must be a string"];
    }
    if (!s.orgId || typeof s.orgId !== "string") {
      errors["scope.orgId"] = ["must be a string"];
    }
    if (s.projectId != null && typeof s.projectId !== "string") {
      errors["scope.projectId"] = ["must be a string"];
    }
  }

  return Object.keys(errors).length > 0 ? errors : null;
}
