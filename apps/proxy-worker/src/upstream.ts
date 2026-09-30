import type { Env } from "./env.js";

/**
 * The ONE place the provider key can go (design §7.2): a constant. There is no
 * base-URL parameter, header or variable, so the proxy is not an open relay
 * for credentials. On stage (and in tests) UPSTREAM_OVERRIDE, a service
 * binding set in configuration, stands in for the provider; prod has none.
 */
export const OPENAI_CHAT_COMPLETIONS = "https://api.openai.com/v1/chat/completions";

/** How long to wait for the provider's response headers; a stream may then run as long as it runs. */
export const UPSTREAM_HEADERS_TIMEOUT_MS = 60_000;

export type UpstreamResult = { ok: true; response: Response } | { ok: false; error: "upstream_unreachable" | "upstream_timeout" };

export async function callUpstream(env: Env, headers: Headers, body: string): Promise<UpstreamResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_HEADERS_TIMEOUT_MS);
  try {
    const request = new Request(OPENAI_CHAT_COMPLETIONS, { method: "POST", headers, body, signal: controller.signal });
    const response = await (env.UPSTREAM_OVERRIDE ? env.UPSTREAM_OVERRIDE.fetch(request) : fetch(request));
    return { ok: true, response };
  } catch {
    // Never the caught error's message (it could quote the request): a code.
    return { ok: false, error: timedOut ? "upstream_timeout" : "upstream_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
