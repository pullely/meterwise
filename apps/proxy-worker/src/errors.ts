// Rule 3 (design §7.4): every error body is built from these fixed strings.
// No catch block anywhere returns or logs a caught error's message, and no
// error echoes a header, a body, or an upstream error.

export const ERRORS = {
  invalid_request: [400, "Send an OpenAI chat-completions JSON body and an x-meterwise-tenant header."],
  unauthenticated: [401, "Send a valid Meterwise API key in the x-meterwise-key header."],
  not_found: [404, "Not found."],
  method_not_allowed: [405, "Method not allowed."],
  budget_exceeded: [429, "This tenant's hard LLM budget is reached for the month."],
  upstream_unreachable: [502, "The provider could not be reached."],
  unavailable: [503, "Meterwise is temporarily unavailable."],
  upstream_timeout: [504, "The provider did not answer in time."],
} as const;

export type ErrorCode = keyof typeof ERRORS;

export function errorResponse(code: ErrorCode, requestId: string): Response {
  const [status, message] = ERRORS[code];
  return new Response(JSON.stringify({ error: { code, message, type: "meterwise_error", requestId } }), {
    status,
    headers: { "content-type": "application/json", "x-meterwise-request-id": requestId },
  });
}
