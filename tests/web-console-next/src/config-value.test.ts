import {
  parseConfigValueInput,
  formatConfigValue,
  configScopeKey,
} from "@web-console-next/components/config/value";

describe("parseConfigValueInput", () => {
  it("parses JSON literals typed", () => {
    expect(parseConfigValueInput("true")).toBe(true);
    expect(parseConfigValueInput("42")).toBe(42);
    expect(parseConfigValueInput('{"a":1}')).toEqual({ a: 1 });
    expect(parseConfigValueInput('"quoted"')).toBe("quoted");
    expect(parseConfigValueInput(" null ")).toBeNull();
  });

  it("falls back to the raw string for non-JSON input", () => {
    expect(parseConfigValueInput("eu-west-1")).toBe("eu-west-1");
    expect(parseConfigValueInput("{not json")).toBe("{not json");
  });

  it("treats empty input as the empty string", () => {
    expect(parseConfigValueInput("")).toBe("");
    expect(parseConfigValueInput("   ")).toBe("");
  });
});

describe("formatConfigValue", () => {
  it("round-trips with parseConfigValueInput", () => {
    for (const raw of ["eu-west-1", "true", "42", '{"a":1}']) {
      const parsed = parseConfigValueInput(raw);
      expect(parseConfigValueInput(formatConfigValue(parsed))).toEqual(parsed);
    }
  });

  it("renders strings bare and structures as JSON", () => {
    expect(formatConfigValue("plain")).toBe("plain");
    expect(formatConfigValue({ a: 1 })).toBe('{"a":1}');
    expect(formatConfigValue(null)).toBe("");
    expect(formatConfigValue(undefined)).toBe("");
  });
});

describe("configScopeKey", () => {
  it("never collides across scope kinds", () => {
    const org = configScopeKey({ kind: "organization", orgId: "o1" });
    const proj = configScopeKey({ kind: "project", orgId: "o1", projectId: "p1" });
    const env = configScopeKey({
      kind: "environment",
      orgId: "o1",
      projectId: "p1",
      environmentId: "e1",
    });
    expect(new Set([org, proj, env]).size).toBe(3);
  });

  it("is stable for equal scopes", () => {
    expect(configScopeKey({ kind: "project", orgId: "o1", projectId: "p1" })).toBe(
      configScopeKey({ kind: "project", orgId: "o1", projectId: "p1" }),
    );
  });
});
