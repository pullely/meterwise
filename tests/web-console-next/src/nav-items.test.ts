import { buildNavSections, isLinkActive } from "@web-console-next/components/shell/nav-items";

describe("buildNavSections", () => {
  it("does not render Workspace/Account nav sections (org switcher + account chip own those)", () => {
    const ids = buildNavSections({ orgSlug: "acme" }).map((s) => s.id);
    expect(ids).not.toContain("workspace");
    expect(ids).not.toContain("account");
    const allHrefs = buildNavSections({ orgSlug: "acme" }).flatMap((s) => s.links.map((l) => l.href));
    expect(allHrefs).not.toContain("/orgs"); // Organizations link removed
    expect(allHrefs).not.toContain("/account");
    expect(allHrefs).not.toContain("/account/security");
  });

  it("flags the Settings link as a sub-panel (renderer shows a chevron)", () => {
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    const settings = org.links.find((l) => l.href === "/orgs/acme/settings")!;
    expect(settings.subPanel).toBe(true);
    const projects = org.links.find((l) => l.href === "/orgs/acme/projects")!;
    expect(projects.subPanel ?? false).toBe(false);
  });

  it("returns no sections when there is no org scope", () => {
    expect(buildNavSections({})).toHaveLength(0);
  });

  it("omits org/project sections without slugs", () => {
    const ids = buildNavSections({}).map((s) => s.id);
    expect(ids).not.toContain("org");
    expect(ids).not.toContain("project");
  });

  it("adds a product-focused org section when orgSlug is present", () => {
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    const hrefs = org.links.map((l) => l.href);
    expect(hrefs).toContain("/orgs/acme/projects");
    expect(hrefs).toContain("/orgs/acme/usage");
    expect(hrefs).toContain("/orgs/acme/settings");
    expect(org.label).toBe("Org · acme");
  });

  it("keeps org administration out of the primary sidebar (moved under Settings)", () => {
    const org = buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "org")!;
    const hrefs = org.links.map((l) => l.href);
    // These now live behind the dedicated Settings surface.
    expect(hrefs).not.toContain("/orgs/acme/members");
    expect(hrefs).not.toContain("/orgs/acme/billing");
    expect(hrefs).not.toContain("/orgs/acme/webhooks");
  });

  it("keeps the Settings link active across nested settings pages", () => {
    expect(isLinkActive("/orgs/acme/settings", "/orgs/acme/settings")).toBe(true);
    expect(isLinkActive("/orgs/acme/settings", "/orgs/acme/settings/webhooks")).toBe(true);
    expect(isLinkActive("/orgs/acme/settings", "/orgs/acme/settings/members")).toBe(true);
  });

  it("adds the project section only when both slugs are present", () => {
    expect(buildNavSections({ orgSlug: "acme" }).find((s) => s.id === "project")).toBeUndefined();
    const project = buildNavSections({ orgSlug: "acme", projectSlug: "web" }).find((s) => s.id === "project")!;
    expect(project.links[0]!.href).toBe("/orgs/acme/projects/web/environments");
  });
});

describe("buildNavSections under the Solo (M0) profile", () => {
  it("relabels the org section to 'Account' and drops Projects + Usage", () => {
    const org = buildNavSections({ orgSlug: "acme" }, true).find((s) => s.id === "org")!;
    expect(org.label).toBe("Account");
    const hrefs = org.links.map((l) => l.href);
    expect(hrefs).toEqual(["/orgs/acme/settings"]); // only Settings survives
    expect(hrefs).not.toContain("/orgs/acme/projects");
    expect(hrefs).not.toContain("/orgs/acme/usage");
  });

  it("suppresses the project section even when a project slug is present", () => {
    const sections = buildNavSections({ orgSlug: "acme", projectSlug: "web" }, true);
    expect(sections.find((s) => s.id === "project")).toBeUndefined();
  });

  it("keeps the full baseline section when soloMode is false", () => {
    const org = buildNavSections({ orgSlug: "acme" }, false).find((s) => s.id === "org")!;
    expect(org.label).toBe("Org · acme");
    expect(org.links.map((l) => l.href)).toEqual([
      "/orgs/acme/projects",
      "/orgs/acme/usage",
      "/orgs/acme/settings",
    ]);
  });
});

describe("isLinkActive", () => {
  it("matches /orgs only exactly (not nested org pages)", () => {
    expect(isLinkActive("/orgs", "/orgs")).toBe(true);
    expect(isLinkActive("/orgs", "/orgs/acme/projects")).toBe(false);
  });

  it("matches /account exactly so it does not swallow /account/security", () => {
    expect(isLinkActive("/account", "/account")).toBe(true);
    expect(isLinkActive("/account", "/account/security")).toBe(false);
    expect(isLinkActive("/account/security", "/account/security")).toBe(true);
  });

  it("matches a link when the path is the href or a child of it", () => {
    expect(isLinkActive("/orgs/acme/usage", "/orgs/acme/usage")).toBe(true);
    expect(isLinkActive("/orgs/acme/webhooks", "/orgs/acme/webhooks/ep_123")).toBe(true);
  });

  it("does not match sibling prefixes", () => {
    expect(isLinkActive("/orgs/acme/api-keys", "/orgs/acme/api-keys-archive")).toBe(false);
  });

  it("returns false for a null pathname", () => {
    expect(isLinkActive("/orgs", null)).toBe(false);
  });
});
