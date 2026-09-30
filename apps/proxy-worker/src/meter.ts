// Reading usage from the provider's response (design §7.5). The caller's copy
// of the body is a separate tee branch, untouched and unbuffered; these
// functions only read the metering branch.

export interface Usage {
  /** The model the provider says answered (a dated snapshot), if it said. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** The provider's usage report arrived. */
  complete: boolean;
}

const MAX_TOKENS = 10_000_000;
const clamp = (n: unknown): number => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_TOKENS) : 0);

function usageOf(obj: unknown): { input: number; output: number } | null {
  const u = (obj as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
  if (!u || typeof u !== "object") return null;
  return { input: clamp(u.prompt_tokens), output: clamp(u.completion_tokens) };
}

function modelOf(obj: unknown): string | null {
  const m = (obj as { model?: unknown } | null)?.model;
  return typeof m === "string" ? m : null;
}

/** A non-streamed completion: one JSON document with `usage`. Capped at 16 MiB. */
export async function meterJson(body: ReadableStream<Uint8Array>): Promise<Usage> {
  const text = await readCapped(body, 16 * 1024 * 1024);
  try {
    const doc = JSON.parse(text) as unknown;
    const u = usageOf(doc);
    return { model: modelOf(doc), inputTokens: u?.input ?? 0, outputTokens: u?.output ?? 0, complete: u !== null };
  } catch {
    return { model: null, inputTokens: 0, outputTokens: 0, complete: false };
  }
}

/**
 * A streamed completion: server-sent events. The final chunk (requested with
 * stream_options.include_usage) carries `usage` and an empty `choices`. A
 * stream that ends without it is incomplete: the tokens known so far are the
 * content chunks seen (about one token each) and no prompt count.
 */
export async function meterStream(body: ReadableStream<Uint8Array>): Promise<Usage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let model: string | null = null;
  let usage: { input: number; output: number } | null = null;
  let contentChunks = 0;
  const line = (raw: string): void => {
    const l = raw.trim();
    if (!l.startsWith("data:")) return;
    const data = l.slice(5).trim();
    if (data === "[DONE]" || data === "") return;
    try {
      const chunk = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] };
      model ??= modelOf(chunk);
      const u = usageOf(chunk);
      if (u) usage = u;
      if (chunk.choices?.some((c) => typeof c.delta?.content === "string" && c.delta.content.length > 0)) contentChunks++;
    } catch {
      // Not JSON: not ours to interpret. Skip it.
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      if (buf.length > 1024 * 1024) buf = ""; // no line is this long; do not grow without bound
    }
    line(buf);
  } catch {
    // The stream broke (the client went away, the provider hung up): what was
    // read so far is what gets reported.
  }
  const u = usage as { input: number; output: number } | null;
  return u
    ? { model, inputTokens: u.input, outputTokens: u.output, complete: true }
    : { model, inputTokens: 0, outputTokens: Math.min(contentChunks, MAX_TOKENS), complete: false };
}

async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length > cap) {
        await reader.cancel();
        return "";
      }
    }
  } catch {
    return "";
  }
  return out + decoder.decode();
}
