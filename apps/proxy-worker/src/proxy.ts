import type { Env } from "./env.js";
import { authenticate, type ProxyActor } from "./auth.js";
import { errorResponse, type ErrorCode } from "./errors.js";
import { forwardHeaders, returnedHeaders } from "./headers.js";
import { newRequestId } from "./ids.js";
import { checkBudget, reportCall, type Tags } from "./ledger.js";
import { KEY_SHAPED_RE, logEvent, safeModel, type Outcome } from "./log.js";
import { meterJson, meterStream } from "./meter.js";
import { callUpstream } from "./upstream.js";

// POST /v1/chat/completions — OpenAI-compatible, streaming and not (design
// §4.3, §7). The customer keeps their OpenAI SDK and its apiKey, changes
// baseURL to this origin, and adds x-meterwise-key and x-meterwise-tenant.

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TAG_RE = /^[^\u0000-\u001f\u007f]+$/;

function tag(headers: Headers, name: string, max: number): string | null | undefined {
  const v = headers.get(name);
  if (v === null) return null;
  const s = v.trim();
  if (s.length === 0) return null;
  return s.length <= max && TAG_RE.test(s) ? s : undefined;
}

function readTags(headers: Headers): Tags | null {
  const tenant = tag(headers, "x-meterwise-tenant", 128);
  const feature = tag(headers, "x-meterwise-feature", 64);
  const user = tag(headers, "x-meterwise-user", 128);
  if (!tenant || feature === undefined || user === undefined) return null;
  return { tenant, feature, user };
}

type ChatBody = Record<string, unknown> & { model: string; stream?: unknown; stream_options?: unknown };

function parseBody(text: string): ChatBody | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  // Printable ASCII only: it is echoed in the x-meterwise-model header. And a
  // "model" shaped like a secret key is refused outright, so a key pasted
  // into the wrong field is never forwarded, stored or logged.
  if (typeof b.model !== "string" || !/^[\x21-\x7e]{1,128}$/.test(b.model) || KEY_SHAPED_RE.test(b.model)) return null;
  if (!Array.isArray(b.messages) || b.messages.length === 0) return null;
  return b as ChatBody;
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  try {
    const text = await request.text();
    return text.length > MAX_BODY_BYTES ? null : text;
  } catch {
    return null;
  }
}

export async function handleChatCompletions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const requestId = newRequestId();
  const started = Date.now();
  let org: string | null = null;
  const fail = (code: ErrorCode, outcome: Outcome, model: string | null = null): Response => {
    const res = errorResponse(code, requestId);
    logEvent({ requestId, org, route: "chat_completions", outcome, status: res.status, upstreamStatus: null, latencyMs: Date.now() - started, model, tokens: null, metered: false });
    return res;
  };

  const auth = await authenticate(env, request.headers.get("x-meterwise-key"), requestId);
  if (!auth.ok) return fail(auth.error, auth.error);
  const actor: ProxyActor = auth.actor;
  org = actor.org;

  const tags = readTags(request.headers);
  const text = await readBody(request);
  const body = text === null ? null : parseBody(text);
  if (!tags || !body) return fail("invalid_request", "invalid_request");

  const requested = body.model.toLowerCase();
  const check = await checkBudget(env, actor, tags, requested, requestId);
  if (check?.decision === "deny") return fail("budget_exceeded", "budget_exceeded", requested);
  const model = check?.decision === "downgrade" ? check.model : body.model;
  const stream = body.stream === true;
  const outgoing: Record<string, unknown> = { ...body, model };
  if (stream) {
    const opts = body.stream_options && typeof body.stream_options === "object" && !Array.isArray(body.stream_options) ? body.stream_options : {};
    outgoing.stream_options = { ...(opts as Record<string, unknown>), include_usage: true };
  }

  const upstream = await callUpstream(env, forwardHeaders(request.headers), JSON.stringify(outgoing));
  if (!upstream.ok) return fail(upstream.error, upstream.error, model.toLowerCase());
  const res = upstream.response;

  const headers = returnedHeaders(res.headers);
  headers.set("x-meterwise-request-id", requestId);
  headers.set("x-meterwise-model", model);
  if (check) headers.set("x-meterwise-decision", check.decision);

  // The provider's own error is its answer to the caller's own request: passed
  // through unchanged, never parsed, logged or stored, and not metered.
  if (!res.ok || !res.body) {
    logEvent({ requestId, org, route: "chat_completions", outcome: "upstream_error", status: res.status, upstreamStatus: res.status, latencyMs: Date.now() - started, model: model.toLowerCase(), tokens: null, metered: false });
    return new Response(res.body, { status: res.status, headers });
  }

  const [toCaller, toMeter] = res.body.tee();
  ctx.waitUntil(
    (async () => {
      const usage = stream ? await meterStream(toMeter) : await meterJson(toMeter);
      const reportedModel = (safeModel(usage.model?.toLowerCase()) ?? model).toLowerCase();
      const latencyMs = Date.now() - started;
      const metered = await reportCall(
        env,
        actor,
        {
          eventId: `px-${requestId.slice(3)}`,
          tags,
          model: reportedModel,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          latencyMs: Math.min(latencyMs, 3_600_000),
          occurredAt: new Date(started).toISOString(),
          usageComplete: usage.complete,
        },
        requestId,
      );
      logEvent({
        requestId,
        org,
        route: "chat_completions",
        outcome: "ok",
        status: res.status,
        upstreamStatus: res.status,
        latencyMs,
        model: reportedModel,
        tokens: { input: usage.inputTokens, output: usage.outputTokens },
        metered,
      });
    })(),
  );
  return new Response(toCaller, { status: res.status, headers });
}
