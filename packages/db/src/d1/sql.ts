// Numbered-placeholder translation for D1.
//
// Every repository in this baseline writes portable SQL with Postgres-style
// numbered placeholders (`$1`, `$2`, …). They are numbered on purpose: a
// placeholder can be referenced out of order (`SET x = $3 WHERE id = $1`) or
// more than once (`created_at, updated_at) VALUES ($5, $5)`), which positional
// `?` cannot express. D1 binds positionally, so the number is resolved here —
// once, in one tested place — instead of forcing every query to duplicate its
// arguments.
//
// The scan is literal-aware: `$1` inside a string literal, a line comment, or
// a block comment is data, not a placeholder, and is left alone.

export interface TranslatedSql {
  /** The statement with every `$n` replaced by a positional `?`. */
  text: string;
  /** Bind values in the order the `?`s appear. */
  values: unknown[];
}

export function translatePlaceholders(text: string, params: readonly unknown[]): TranslatedSql {
  let out = "";
  const values: unknown[] = [];

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    // ── Regions where a `$n` is not a placeholder ──
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < text.length) {
        out += text[i];
        // '' (or "") inside a literal is an escaped quote, not its end.
        if (text[i] === quote) {
          if (text[i + 1] === quote) {
            out += text[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < text.length && text[i] !== "\n") {
        out += text[i];
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "/*";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i];
        i += 1;
      }
      out += "*/";
      i += 2;
      continue;
    }

    // ── The placeholder itself ──
    if (ch === "$" && next !== undefined && next >= "0" && next <= "9") {
      let j = i + 1;
      let digits = "";
      for (; j < text.length; j += 1) {
        const digit = text[j];
        if (digit === undefined || digit < "0" || digit > "9") break;
        digits += digit;
      }
      const index = Number(digits);
      if (index < 1 || index > params.length) {
        throw new Error(
          `d1: statement references $${index} but ${params.length} parameter(s) were supplied`,
        );
      }
      values.push(params[index - 1]);
      out += "?";
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { text: out, values };
}

/** D1 binds JS primitives only. Anything richer (Date, plain object, array —
 *  the JSON columns this schema stores as TEXT) is normalized here so callers
 *  keep writing natural values. Booleans become 0/1: SQLite has no boolean. */
export function toBindValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}
