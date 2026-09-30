// MW2: budget limits typed in dollars become nano-USD integers, exactly.

/** "$12.50" from a dollar amount typed by a person → nano-USD, exactly (no float arithmetic). */
export function dollarsToNano(input: string): number | null {
  const s = input.trim().replace(/^\$/, "");
  if (s === "") return null;
  const m = s.match(/^(\d{1,7})(?:\.(\d{1,9}))?$/);
  if (!m) return Number.NaN;
  return Number(m[1]) * 1_000_000_000 + Number((m[2] ?? "").padEnd(9, "0"));
}
