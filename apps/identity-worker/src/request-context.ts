import type { RequestContext } from "./services/auth.js";

export function extractRequestContext(request: Request, requestId: string): RequestContext {
  return {
    requestId,
    ip: request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? null,
    userAgent: request.headers.get("user-agent") ?? null,
  };
}
