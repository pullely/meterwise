import type { ErrorCode } from "@saas/contracts/errors";

export function successResponse<T>(data: T, requestId: string, status = 200): Response {
  return Response.json(
    { data, meta: { requestId, cursor: null } },
    { status, headers: { "content-type": "application/json" } },
  );
}

export function pagedResponse<T>(data: T, requestId: string, cursor: string | null): Response {
  return Response.json(
    { data, meta: { requestId, cursor } },
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export function errorResponse(
  code: ErrorCode | string,
  message: string,
  status: number,
  requestId: string,
  details?: Record<string, unknown>,
): Response {
  return Response.json(
    { error: { code, message, details: details ?? {}, requestId } },
    { status, headers: { "content-type": "application/json" } },
  );
}

export function notFound(requestId: string, path?: string): Response {
  return errorResponse("not_found", path ? `Route not found: ${path}` : "Not found", 404, requestId);
}

export function methodNotAllowed(requestId: string): Response {
  return errorResponse("unsupported", "Method not allowed", 405, requestId);
}

export function validationError(requestId: string, fields: Record<string, string[]>): Response {
  return errorResponse("validation_failed", "Validation failed", 422, requestId, { fields });
}

export function unavailable(requestId: string): Response {
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}
