import type { ErrorCode } from "@saas/contracts/errors";
import { shouldEmitTimingLog, type Timings } from "@saas/contracts/timing";

/** Attach a `Server-Timing` header (when phases exist) and emit a structured
 *  timing log line. Returns the same response for chaining. */
export function withTimings(response: Response, requestId: string, route: string, timings: Timings): Response {
  const header = timings.header();
  if (header) response.headers.set("Server-Timing", header);
  // PERF14b: header always set; the log line is sampled to bound Workers Logs cost.
  const phases = timings.toJSON();
  if (shouldEmitTimingLog(phases)) {
    // eslint-disable-next-line no-console -- structured timing line for prod observability
    console.log(JSON.stringify({ level: "info", msg: "timing", route, requestId, phases }));
  }
  return response;
}

export function successResponse<T>(data: T, requestId: string, status = 200): Response {
  return Response.json(
    {
      data,
      meta: { requestId, cursor: null },
    },
    { status, headers: { "content-type": "application/json" } },
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
    {
      error: { code, message, details: details ?? {}, requestId },
    },
    { status, headers: { "content-type": "application/json" } },
  );
}

export function notFound(requestId: string, path: string): Response {
  return errorResponse("not_found", `Route not found: ${path}`, 404, requestId);
}

export function methodNotAllowed(requestId: string): Response {
  return errorResponse("unsupported", "Method not allowed", 405, requestId);
}

export function validationError(requestId: string, fields: Record<string, string[]>): Response {
  return errorResponse("validation_failed", "Validation failed", 422, requestId, { fields });
}
