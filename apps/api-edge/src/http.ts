import type { ErrorCode } from "@saas/contracts/errors";
import type { Timings } from "@saas/contracts/timing";
import { appendServerTiming, shouldEmitTimingLog } from "@saas/contracts/timing";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

/** Append the edge's own phases to the downstream worker's `Server-Timing`
 *  header so a single response carries the end-to-end breakdown, and emit a
 *  (sampled) structured timing log line. The header is always set; the log line
 *  is sampled (PERF14) to bound Workers Logs ingestion cost. Returns the same
 *  response for chaining. */
export function withEdgeTimings(response: Response, requestId: string, route: string, timings: Timings): Response {
  const addition = timings.header();
  if (addition) {
    response.headers.set("Server-Timing", appendServerTiming(response.headers.get("Server-Timing"), addition));
  }
  const phases = timings.toJSON();
  if (shouldEmitTimingLog(phases)) {
    // eslint-disable-next-line no-console -- structured timing line for prod observability
    console.log(JSON.stringify({ level: "info", msg: "timing", route, requestId, phases }));
  }
  return response;
}

export function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function generateRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return `req_${hex}`;
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
