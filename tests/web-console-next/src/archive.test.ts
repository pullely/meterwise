import {
  removeById,
  findById,
  confirmArchiveMatches,
} from "@web-console-next/components/settings/archive";

const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("removeById", () => {
  it("removes the matching item without mutating the input", () => {
    const out = removeById(items, "b");
    expect(out.map((i) => i.id)).toEqual(["a", "c"]);
    expect(items).toHaveLength(3); // immutable
  });
  it("is a no-op when the id is absent", () => {
    expect(removeById(items, "z").map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("findById", () => {
  it("finds or returns null", () => {
    expect(findById(items, "c")).toEqual({ id: "c" });
    expect(findById(items, "z")).toBeNull();
  });
});

describe("confirmArchiveMatches", () => {
  it("requires an exact match (whitespace tolerated)", () => {
    expect(confirmArchiveMatches("web-app", "web-app")).toBe(true);
    expect(confirmArchiveMatches("  web-app ", "web-app")).toBe(true);
    expect(confirmArchiveMatches("web", "web-app")).toBe(false);
  });
  it("rejects empty expected", () => {
    expect(confirmArchiveMatches("", "")).toBe(false);
  });
});
