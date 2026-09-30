// A mock of the one OpenAI route the proxy forwards to (MW3). Deterministic:
// every completion reports 1,000 prompt tokens and 500 completion tokens, and
// answers with the requested model plus a dated snapshot suffix, the way the
// real API does. It never echoes a header VALUE: it reports the header NAMES
// it received and a SHA-256 of the Authorization value, so a smoke can prove
// the key arrived byte-for-byte without the key appearing in any response.

export const PROMPT_TOKENS = 1000;
export const COMPLETION_TOKENS = 500;
const WORDS = ["Hello", " from", " the", " mock", " upstream."];

async function sha256(value: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

function snapshot(model: string): string {
  return /-\d{4}-\d{2}-\d{2}$/.test(model) ? model : `${model}-2024-08-06`;
}

export async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return Response.json({ status: "ok", service: "mock-upstream" });
  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    return Response.json({ error: { message: "not found", type: "invalid_request_error" } }, { status: 404 });
  }
  const auth = request.headers.get("authorization");
  const seen = {
    "x-mock-header-names": [...request.headers.keys()].sort().join(","),
    "x-mock-authorization-sha256": auth ? await sha256(auth) : "none",
  };
  if (!auth || !auth.startsWith("Bearer ")) {
    return Response.json({ error: { message: "missing bearer", type: "invalid_request_error" } }, { status: 401, headers: seen });
  }
  let body: { model?: unknown; stream?: unknown; stream_options?: { include_usage?: unknown } };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: { message: "invalid json", type: "invalid_request_error" } }, { status: 400, headers: seen });
  }
  const model = typeof body.model === "string" ? body.model : "unknown";
  if (model === "mock-error-401") return Response.json({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }, { status: 401, headers: seen });
  if (model === "mock-error-500") return Response.json({ error: { message: "The server had an error", type: "server_error" } }, { status: 500, headers: seen });
  const id = `chatcmpl-mock${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = { prompt_tokens: PROMPT_TOKENS, completion_tokens: COMPLETION_TOKENS, total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS };
  if (body.stream !== true) {
    return Response.json(
      {
        id,
        object: "chat.completion",
        created,
        model: snapshot(model),
        choices: [{ index: 0, message: { role: "assistant", content: WORDS.join("") }, finish_reason: "stop" }],
        usage,
      },
      { headers: seen },
    );
  }
  const includeUsage = body.stream_options?.include_usage === true;
  const enc = new TextEncoder();
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: snapshot(model), choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  let parts = [chunk({ role: "assistant", content: "" }, null), ...WORDS.map((w) => chunk({ content: w }, null)), chunk({}, "stop")];
  // "mock-disconnect": the stream breaks off after two words, before the
  // usage chunk and [DONE] (what the proxy sees when a stream is cut short).
  if (model === "mock-disconnect") parts = parts.slice(0, 3);
  else if (includeUsage) parts.push(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: snapshot(model), choices: [], usage })}\n\n`);
  if (model !== "mock-disconnect") parts.push("data: [DONE]\n\n");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", ...seen } });
}

export default {
  fetch(request: Request): Promise<Response> {
    return handle(request);
  },
} satisfies ExportedHandler;
