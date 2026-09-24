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

export function successResponse(
  data: unknown,
  requestId: string,
  status = 200,
): Response {
  return new Response(
    JSON.stringify({ data, meta: { requestId } }),
    {
      status,
      headers: { "content-type": "application/json", "x-request-id": requestId },
    },
  );
}

export function listResponse(
  data: unknown,
  requestId: string,
  cursor: unknown = null,
): Response {
  return new Response(
    JSON.stringify({ data, meta: { requestId, cursor } }),
    {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": requestId },
    },
  );
}

export function errorResponse(
  code: string,
  message: string,
  status: number,
  requestId: string,
  details?: unknown,
): Response {
  const body: Record<string, unknown> = {
    error: { code, message, requestId, ...(details ? { details } : {}) },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

export function notFound(requestId: string, path?: string): Response {
  return errorResponse("not_found", path ? `Not found: ${path}` : "Not found", 404, requestId);
}

export function methodNotAllowed(requestId: string): Response {
  return errorResponse("method_not_allowed", "Method not allowed", 405, requestId);
}

export function validationError(requestId: string, message: string, details?: unknown): Response {
  return errorResponse("validation_error", message, 400, requestId, details);
}
