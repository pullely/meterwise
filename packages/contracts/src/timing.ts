// Server-Timing observability helper (PERF4 / task 0133).
//
// A tiny, dependency-free phase timer used to make per-hop and per-query cost
// measurable in production. Each hot-path worker builds a `Timings`, records its
// phases (auth, authz, db, …), and emits both a `Server-Timing` response header
// and a structured timing log line. api-edge measures its own edge phases and
// appends them to the downstream worker's header so a single response carries
// the end-to-end breakdown.
//
// No secrets/PII: phase names are static labels and values are durations only.

export interface PhaseTiming {
  name: string;
  durationMs: number;
  description?: string;
}

export interface Timings {
  /** Start a phase; returns a function that records its elapsed duration. */
  start(name: string, description?: string): () => void;
  /** Time an async function under a phase name. */
  measure<T>(name: string, fn: () => Promise<T>, description?: string): Promise<T>;
  /** Record a precomputed duration (e.g. parsed from a downstream header). */
  add(name: string, durationMs: number, description?: string): void;
  /** All recorded phases, in insertion order. */
  phases(): PhaseTiming[];
  /** Render the `Server-Timing` header value (empty string if no phases). */
  header(): string;
  /** Flat `{ phase: ms }` snapshot for structured logging. */
  toJSON(): Record<string, number>;
}

const MAX_PHASES = 64;

function sanitizeName(name: string): string {
  // Server-Timing names are tokens; keep them header-safe and label-only.
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_");
  return cleaned.length > 0 ? cleaned : "phase";
}

function roundMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.round(ms * 1000) / 1000;
}

export function createTimings(now: () => number = () => Date.now()): Timings {
  const recorded: PhaseTiming[] = [];

  function record(name: string, durationMs: number, description?: string): void {
    if (recorded.length >= MAX_PHASES) return;
    const phase: PhaseTiming = { name: sanitizeName(name), durationMs: roundMs(durationMs) };
    if (description) phase.description = description;
    recorded.push(phase);
  }

  return {
    start(name, description) {
      const startedAt = now();
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        record(name, now() - startedAt, description);
      };
    },
    async measure(name, fn, description) {
      const startedAt = now();
      try {
        return await fn();
      } finally {
        record(name, now() - startedAt, description);
      }
    },
    add(name, durationMs, description) {
      record(name, durationMs, description);
    },
    phases() {
      return recorded.map((p) => ({ ...p }));
    },
    header() {
      return recorded
        .map((p) => {
          const parts = [p.name, `dur=${p.durationMs}`];
          if (p.description) {
            // desc must be a quoted-string; strip quotes/backslashes defensively.
            parts.push(`desc="${p.description.replace(/["\\]/g, "")}"`);
          }
          return parts.join(";");
        })
        .join(", ");
    },
    toJSON() {
      const out: Record<string, number> = {};
      for (const p of recorded) out[p.name] = p.durationMs;
      return out;
    },
  };
}

/** Parse the numeric `dur=` of a named metric from a `Server-Timing` header. */
export function parseServerTimingDuration(header: string | null, name: string): number | null {
  if (!header) return null;
  const target = sanitizeName(name);
  for (const metric of header.split(",")) {
    const segments = metric.split(";").map((s) => s.trim());
    const metricName = segments[0];
    if (metricName !== target) continue;
    for (const seg of segments.slice(1)) {
      const m = /^dur=(-?\d+(?:\.\d+)?)$/.exec(seg);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

/** Append additional `Server-Timing` metrics to an existing header value. */
export function appendServerTiming(existing: string | null, addition: string): string {
  if (!addition) return existing ?? "";
  if (!existing) return addition;
  return `${existing}, ${addition}`;
}

/**
 * Sampling gate for the structured timing LOG line (PERF14 cost guard).
 *
 * The `Server-Timing` *header* is always emitted (free, per-response). The
 * structured `console.log` line, by contrast, is what hits Workers Logs
 * ingestion — at ~2–3 lines per request across the worker chain it is a real,
 * traffic-scaling cost. This gate keeps the log volume bounded while never
 * dropping a signal that matters: it ALWAYS emits when any recorded phase is
 * slow (so regressions are never sampled away), and otherwise emits at `rate`
 * (0..1, default 1-in-10). `random` is injectable for tests.
 */
export function shouldEmitTimingLog(
  phases: Record<string, number>,
  opts?: { rate?: number; slowMs?: number; random?: () => number },
): boolean {
  const slowMs = opts?.slowMs ?? 1000;
  for (const v of Object.values(phases)) {
    if (v >= slowMs) return true;
  }
  const rate = opts?.rate ?? 0.1;
  const r = (opts?.random ?? Math.random)();
  return r < rate;
}
