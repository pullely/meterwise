import {
  validateDisplayName,
  toDisplayNameValue,
  buildProfilePatch,
  initials,
  DISPLAY_NAME_MAX,
} from "@web-console-next/components/account/profile";

describe("validateDisplayName", () => {
  it("allows empty (clears the name)", () => {
    expect(validateDisplayName("").ok).toBe(true);
    expect(validateDisplayName("   ").ok).toBe(true);
  });
  it("rejects over the bound, accepts at the bound", () => {
    expect(validateDisplayName("a".repeat(DISPLAY_NAME_MAX)).ok).toBe(true);
    expect(validateDisplayName("a".repeat(DISPLAY_NAME_MAX + 1)).ok).toBe(false);
  });
});

describe("toDisplayNameValue", () => {
  it("trims and maps empty → null", () => {
    expect(toDisplayNameValue("  Ada ")).toBe("Ada");
    expect(toDisplayNameValue("   ")).toBeNull();
  });
});

describe("buildProfilePatch", () => {
  it("returns null when unchanged (incl. whitespace-only edits)", () => {
    expect(buildProfilePatch("Ada", "Ada")).toBeNull();
    expect(buildProfilePatch("Ada", " Ada ")).toBeNull();
    expect(buildProfilePatch(null, "")).toBeNull();
    expect(buildProfilePatch(null, "   ")).toBeNull();
  });
  it("emits the new value when changed", () => {
    expect(buildProfilePatch("Ada", "Grace")).toEqual({ displayName: "Grace" });
  });
  it("emits null when clearing a previously-set name", () => {
    expect(buildProfilePatch("Ada", "")).toEqual({ displayName: null });
  });
});

describe("initials", () => {
  it("uses the display name when present", () => {
    expect(initials("Ada Lovelace", "ada@x.io")).toBe("AL");
  });
  it("falls back to email local-part segments", () => {
    expect(initials(null, "ada.lovelace@x.io")).toBe("AL");
    expect(initials("", "ada@x.io")).toBe("AD");
  });
  it("handles a single token", () => {
    expect(initials("Madonna", "m@x.io")).toBe("MA");
  });
});
