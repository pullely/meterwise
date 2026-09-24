import { slugify } from "@web-console-next/lib/slug";

describe("slugify", () => {
  it("lowercases and hyphenates words", () => {
    expect(slugify("Web App")).toBe("web-app");
    expect(slugify("Acme, Inc.")).toBe("acme-inc");
  });

  it("collapses runs of separators and trims edge hyphens", () => {
    expect(slugify("  Hello   World!!  ")).toBe("hello-world");
    expect(slugify("--Already--Sluggish--")).toBe("already-sluggish");
  });

  it("strips diacritics", () => {
    expect(slugify("Café Déjà")).toBe("cafe-deja");
  });

  it("produces a schema-valid slug (only [a-z0-9-])", () => {
    expect(slugify("Prod / Staging #1")).toMatch(/^[a-z0-9-]*$/);
  });

  it("bounds length and never leaves a trailing hyphen after truncation", () => {
    const out = slugify("a".repeat(40) + " " + "b".repeat(40), 48);
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out.endsWith("-")).toBe(false);
  });

  it("returns an empty string for empty / symbol-only input", () => {
    expect(slugify("")).toBe("");
    expect(slugify("!!!")).toBe("");
  });
});
