import {
  personalWorkspaceName,
  personalWorkspaceSlug,
} from "@web-console-next/lib/personal-workspace";

/**
 * The console's Solo self-heal (onboarding provisions the personal workspace
 * when the identity worker's best-effort login hook didn't land) must derive the
 * SAME name and slug as the identity worker. Determinism is what makes the two
 * paths converge on one organization instead of racing into two — the loser hits
 * a 409 (already exists), which the console treats as success.
 */

describe("personalWorkspaceName", () => {
  it("prefers the display name", () => {
    expect(personalWorkspaceName({ id: "usr_1", email: "ada@example.com", displayName: "Ada L" })).toBe("Ada L");
  });

  it("falls back to the email local-part", () => {
    expect(personalWorkspaceName({ id: "usr_1", email: "ada@example.com", displayName: null })).toBe("ada");
  });

  it("falls back to a stable default when there is nothing to use", () => {
    expect(personalWorkspaceName({ id: "usr_1", email: "", displayName: "   " })).toBe("Personal");
  });

  it("bounds the name at membership's 100-char limit", () => {
    const long = "x".repeat(200);
    expect(personalWorkspaceName({ id: "usr_1", email: "a@b.c", displayName: long })).toHaveLength(100);
  });
});

describe("personalWorkspaceSlug", () => {
  it("is deterministic in the user id", () => {
    expect(personalWorkspaceSlug("usr_abc123")).toBe("personal-usr-abc123");
    expect(personalWorkspaceSlug("usr_abc123")).toBe(personalWorkspaceSlug("usr_abc123"));
  });

  it("satisfies membership's slug rule", () => {
    const slug = personalWorkspaceSlug("USR_Ab!!c__9");
    expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    expect(slug.length).toBeLessThanOrEqual(63);
  });

  it("never ends in a hyphen after truncation", () => {
    expect(personalWorkspaceSlug(`${"a".repeat(60)}___`)).not.toMatch(/-$/);
  });
});

// Parity fixtures. These are the exact values `ensurePersonalOrg` produces
// (tests/identity-worker/src/solo-mode.test.ts pins the same rules on the worker
// side); if either side drifts, one of the two suites goes red.
describe("parity with the identity worker's provisioning rules", () => {
  const cases: Array<[{ id: string; email: string; displayName: string | null }, string, string]> = [
    [{ id: "usr_abc123", email: "ada@example.com", displayName: "Ada L" }, "Ada L", "personal-usr-abc123"],
    [{ id: "usr_abc123", email: "ada@example.com", displayName: null }, "ada", "personal-usr-abc123"],
    [{ id: "USR_Ab!!c__9", email: "", displayName: null }, "Personal", "personal-usr-ab-c-9"],
  ];

  it.each(cases)("derives the worker's name and slug (%#)", (user, name, slug) => {
    expect(personalWorkspaceName(user)).toBe(name);
    expect(personalWorkspaceSlug(user.id)).toBe(slug);
  });
});
