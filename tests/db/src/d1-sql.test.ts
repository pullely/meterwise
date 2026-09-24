import { translatePlaceholders, toBindValue } from "@saas/db/d1";

describe("translatePlaceholders", () => {
  it("rewrites numbered placeholders to positional ones in order", () => {
    const { text, values } = translatePlaceholders(
      "SELECT * FROM identity_users WHERE id = $1 AND status = $2",
      ["u-001", "active"],
    );
    expect(text).toBe("SELECT * FROM identity_users WHERE id = ? AND status = ?");
    expect(values).toEqual(["u-001", "active"]);
  });

  it("duplicates the bound value when a placeholder is referenced twice", () => {
    // `created_at, updated_at) VALUES ($5, $5)` is the shape that makes
    // numbered placeholders worth keeping — positional `?` cannot express it
    // without the caller passing the same value twice.
    const { text, values } = translatePlaceholders(
      "INSERT INTO t (a, created_at, updated_at) VALUES ($1, $2, $2)",
      ["a", "2026-01-01T00:00:00.000Z"],
    );
    expect(text).toBe("INSERT INTO t (a, created_at, updated_at) VALUES (?, ?, ?)");
    expect(values).toEqual(["a", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
  });

  it("reorders bound values to match out-of-order placeholders", () => {
    const { text, values } = translatePlaceholders(
      "UPDATE identity_sessions SET revoked_at = $2 WHERE id = $1",
      ["sess-1", "2026-01-01T00:00:00.000Z"],
    );
    expect(text).toBe("UPDATE identity_sessions SET revoked_at = ? WHERE id = ?");
    expect(values).toEqual(["2026-01-01T00:00:00.000Z", "sess-1"]);
  });

  it("leaves a $n inside a string literal alone", () => {
    const { text, values } = translatePlaceholders(
      "SELECT '$1 is data' AS note WHERE id = $1",
      ["u-001"],
    );
    expect(text).toBe("SELECT '$1 is data' AS note WHERE id = ?");
    expect(values).toEqual(["u-001"]);
  });

  it("leaves a $n inside a line comment alone", () => {
    const { text, values } = translatePlaceholders(
      "SELECT 1 -- $9 in a comment\nWHERE id = $1",
      ["u-001"],
    );
    expect(text).toBe("SELECT 1 -- $9 in a comment\nWHERE id = ?");
    expect(values).toEqual(["u-001"]);
  });

  it("leaves a $n inside a block comment alone", () => {
    const { text } = translatePlaceholders("SELECT 1 /* $9 */ WHERE a = $1", ["x"]);
    expect(text).toBe("SELECT 1 /* $9 */ WHERE a = ?");
  });

  it("handles an escaped quote inside a literal without losing the string state", () => {
    const { text, values } = translatePlaceholders(
      "SELECT 'it''s $2 fine' AS note WHERE id = $1",
      ["u-001"],
    );
    expect(text).toBe("SELECT 'it''s $2 fine' AS note WHERE id = ?");
    expect(values).toEqual(["u-001"]);
  });

  it("passes through a statement with no placeholders", () => {
    const { text, values } = translatePlaceholders("SELECT 1 AS ok", []);
    expect(text).toBe("SELECT 1 AS ok");
    expect(values).toEqual([]);
  });

  it("refuses a placeholder with no matching parameter", () => {
    expect(() => translatePlaceholders("SELECT * FROM t WHERE id = $2", ["only-one"])).toThrow(
      /references \$2 but 1 parameter/,
    );
  });
});

describe("toBindValue", () => {
  it("passes primitives through untouched", () => {
    expect(toBindValue("text")).toBe("text");
    expect(toBindValue(42)).toBe(42);
  });

  it("maps undefined to null so an omitted field is stored as NULL", () => {
    expect(toBindValue(undefined)).toBeNull();
    expect(toBindValue(null)).toBeNull();
  });

  it("serializes a Date to ISO-8601, matching how timestamps are stored", () => {
    expect(toBindValue(new Date("2026-01-01T12:00:00.000Z"))).toBe("2026-01-01T12:00:00.000Z");
  });

  it("maps booleans to 0/1 because SQLite has no boolean type", () => {
    expect(toBindValue(true)).toBe(1);
    expect(toBindValue(false)).toBe(0);
  });

  it("serializes objects and arrays as JSON text", () => {
    expect(toBindValue({ a: 1 })).toBe('{"a":1}');
    expect(toBindValue(["x", "y"])).toBe('["x","y"]');
  });
});
