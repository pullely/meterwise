import { describe, expect, it } from "vitest";

import { formatErrorJson, formatOutput, parseOutputMode } from "../output/index.js";

describe("output — parseOutputMode", () => {
  it("defaults to human", () => {
    expect(parseOutputMode(undefined)).toBe("human");
    expect(parseOutputMode(true)).toBe("human");
    expect(parseOutputMode("human")).toBe("human");
  });
  it("recognises json", () => {
    expect(parseOutputMode("json")).toBe("json");
  });
});

describe("output — JSON mode shape", () => {
  it("emits the data field verbatim", () => {
    const out = formatOutput({ mode: "json", data: { hello: "world" } });
    expect(JSON.parse(out)).toEqual({ hello: "world" });
  });

  it("wraps rows under `items` when no data override is given", () => {
    const out = formatOutput({
      mode: "json",
      columns: ["id", "name"],
      rows: [{ id: "x", name: "y" }],
    });
    expect(JSON.parse(out)).toEqual({ items: [{ id: "x", name: "y" }] });
  });

  it("emits a record verbatim", () => {
    const out = formatOutput({ mode: "json", record: { a: "1", b: "2" } });
    expect(JSON.parse(out)).toEqual({ a: "1", b: "2" });
  });

  it("error envelope shape", () => {
    const s = formatErrorJson({
      code: "validation_failed",
      message: "boom",
      requestId: "req_abc",
    });
    expect(JSON.parse(s)).toEqual({
      error: { code: "validation_failed", message: "boom", requestId: "req_abc" },
    });
  });

  it("error envelope omits requestId when absent", () => {
    const s = formatErrorJson({ code: "x", message: "y" });
    expect(JSON.parse(s)).toEqual({ error: { code: "x", message: "y" } });
  });
});

describe("output — human mode shape", () => {
  it("renders a table with header + separator + rows", () => {
    const out = formatOutput({
      mode: "human",
      columns: ["id", "name"],
      rows: [
        { id: "1", name: "alpha" },
        { id: "20", name: "b" },
      ],
    });
    const lines = out.split("\n");
    expect(lines[0]).toMatch(/^id\s+name\s*$/);
    expect(lines[1]).toMatch(/^-+\s+-+\s*$/);
    expect(lines[2]).toMatch(/^1\s+alpha\s*$/);
    expect(lines[3]).toMatch(/^20\s+b\s*$/);
  });

  it("renders an empty list as `(no rows)`", () => {
    const out = formatOutput({ mode: "human", columns: ["id"], rows: [] });
    expect(out).toContain("(no rows)");
  });

  it("renders a record as key:value lines, padded", () => {
    const out = formatOutput({
      mode: "human",
      record: { apiUrl: "https://api.test", organizations: "3" },
    });
    expect(out).toContain("apiUrl");
    expect(out).toContain("organizations");
    expect(out).toContain(":");
    expect(out).toContain("https://api.test");
  });

  it("renders an empty record as (empty)", () => {
    const out = formatOutput({ mode: "human", record: {} });
    expect(out).toBe("(empty)");
  });

  it("supports an optional title above the body", () => {
    const out = formatOutput({
      mode: "human",
      title: "Members of org_1",
      columns: ["id"],
      rows: [{ id: "m_1" }],
    });
    expect(out.startsWith("Members of org_1")).toBe(true);
  });
});
