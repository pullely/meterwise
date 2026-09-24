// Output formatting for the CLI.
//
// Two modes:
//   - "human" (default): for list commands, a small left-aligned table;
//     for single-record reads, a `key: value` block. Strings are emitted
//     verbatim. No timestamps are injected by the CLI (PR Boundary §C6).
//   - "json": one JSON document per command invocation. On success the CLI
//     emits the SDK response shape; on error it emits
//     `{ error: { code, message, requestId? } }` and exits non-zero.
//
// Stability contract: JSON output mode must be deterministic given
// deterministic SDK responses (Constraints §6). Tests assert exact shape.

export type OutputMode = "human" | "json";

export function parseOutputMode(value: string | boolean | undefined): OutputMode {
  if (value === "json") return "json";
  return "human";
}

export interface ErrorEnvelopeOut {
  code: string;
  message: string;
  requestId?: string;
}

export interface FormatInput {
  readonly mode: OutputMode;
  /**
   * For list rendering. When provided, human mode prints a table with these
   * columns; json mode emits `{ items: rows }` (or a caller-supplied `data`
   * value, see below).
   */
  readonly columns?: ReadonlyArray<string>;
  readonly rows?: ReadonlyArray<Readonly<Record<string, string>>>;
  /**
   * For single-record / scalar output. When provided, human mode prints a
   * `key: value` block; json mode emits the value as-is.
   */
  readonly record?: Readonly<Record<string, string>>;
  /**
   * Override for json mode. When set, this exact value is JSON-serialised.
   * If both `data` and `rows` are set, `data` wins for json output but
   * `rows` still drives the human table.
   */
  readonly data?: unknown;
  /** Optional one-line title shown in human mode above the table/record. */
  readonly title?: string;
}

export function formatOutput(input: FormatInput): string {
  if (input.mode === "json") {
    if (input.data !== undefined) {
      return JSON.stringify(input.data);
    }
    if (input.rows && input.columns) {
      return JSON.stringify({ items: input.rows });
    }
    if (input.record) {
      return JSON.stringify(input.record);
    }
    return JSON.stringify({});
  }

  // Human mode.
  const lines: string[] = [];
  if (input.title) lines.push(input.title);

  if (input.rows && input.columns) {
    lines.push(formatTable(input.columns, input.rows));
  } else if (input.record) {
    lines.push(formatKeyValue(input.record));
  }

  return lines.join("\n");
}

export function formatErrorJson(err: ErrorEnvelopeOut): string {
  const out: ErrorEnvelopeOut = { code: err.code, message: err.message };
  if (err.requestId !== undefined) out.requestId = err.requestId;
  return JSON.stringify({ error: out });
}

function formatTable(
  columns: ReadonlyArray<string>,
  rows: ReadonlyArray<Readonly<Record<string, string>>>,
): string {
  const widths = columns.map((col) => {
    let w = col.length;
    for (const row of rows) {
      const v = row[col] ?? "";
      if (v.length > w) w = v.length;
    }
    return w;
  });
  const pad = (value: string, width: number): string => value.padEnd(width, " ");
  const header = columns.map((c, i) => pad(c, widths[i] ?? c.length)).join("  ");
  const sep = columns.map((_c, i) => "-".repeat(widths[i] ?? 0)).join("  ");
  const body = rows
    .map((row) =>
      columns.map((c, i) => pad(row[c] ?? "", widths[i] ?? 0)).join("  "),
    )
    .join("\n");
  if (rows.length === 0) {
    return `${header}\n${sep}\n(no rows)`;
  }
  return `${header}\n${sep}\n${body}`;
}

function formatKeyValue(record: Readonly<Record<string, string>>): string {
  const keys = Object.keys(record);
  if (keys.length === 0) return "(empty)";
  const pad = Math.max(...keys.map((k) => k.length));
  return keys
    .map((k) => `${k.padEnd(pad, " ")} : ${record[k] ?? ""}`)
    .join("\n");
}
