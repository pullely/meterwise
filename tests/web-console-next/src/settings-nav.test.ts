import {
  buildSettingsNav,
  flattenSettingsNav,
  isSettingsLinkActive,
} from "@web-console-next/components/shell/settings-nav";

describe("buildSettingsNav", () => {
  it("groups settings into Organization, Billing, and Developer", () => {
    const ids = buildSettingsNav("acme").map((g) => g.id);
    expect(ids).toEqual(["organization", "billing", "developer"]);
  });

  it("roots every link under the org settings base", () => {
    for (const link of flattenSettingsNav(buildSettingsNav("acme"))) {
      expect(link.href.startsWith("/orgs/acme/settings")).toBe(true);
    }
  });

  it("exposes General as the exact-match settings index", () => {
    const general = flattenSettingsNav(buildSettingsNav("acme")).find((l) => l.label === "General")!;
    expect(general.href).toBe("/orgs/acme/settings");
    expect(general.exact).toBe(true);
  });

  it("includes the migrated administration surfaces", () => {
    const hrefs = flattenSettingsNav(buildSettingsNav("acme")).map((l) => l.href);
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/orgs/acme/settings/members",
        "/orgs/acme/settings/invitations",
        "/orgs/acme/settings/billing",
        "/orgs/acme/settings/api-keys",
        "/orgs/acme/settings/webhooks",
        "/orgs/acme/settings/config",
        "/orgs/acme/settings/audit",
      ]),
    );
  });
});

describe("buildSettingsNav under the Solo (M0) profile", () => {
  const solo = () => buildSettingsNav("acme", true);

  it("relabels the org group to 'Account' and drops the empty Developer-less surfaces", () => {
    const groups = solo();
    const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
    expect(byId["organization"]!.label).toBe("Account");
    // Billing is kept; Developer survives only because Config remains.
    expect(groups.map((g) => g.id)).toEqual(["organization", "billing", "developer"]);
  });

  it("hides members, invitations, api-keys, webhooks, integrations, and audit", () => {
    const hrefs = flattenSettingsNav(solo()).map((l) => l.href);
    for (const suppressed of [
      "/orgs/acme/settings/members",
      "/orgs/acme/settings/invitations",
      "/orgs/acme/settings/api-keys",
      "/orgs/acme/settings/webhooks",
      "/orgs/acme/settings/integrations",
      "/orgs/acme/settings/audit",
    ]) {
      expect(hrefs).not.toContain(suppressed);
    }
  });

  it("keeps the single-user surfaces: General, Notifications, Billing, Config", () => {
    const hrefs = flattenSettingsNav(solo()).map((l) => l.href);
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/orgs/acme/settings", // General
        "/orgs/acme/settings/notifications",
        "/orgs/acme/settings/billing",
        "/orgs/acme/settings/config",
      ]),
    );
  });

  it("is identical to the baseline when soloMode is false", () => {
    expect(buildSettingsNav("acme", false)).toEqual(buildSettingsNav("acme", false));
    expect(buildSettingsNav("acme", false).map((g) => g.id)).toEqual([
      "organization",
      "billing",
      "developer",
    ]);
  });
});

describe("isSettingsLinkActive", () => {
  const links = flattenSettingsNav(buildSettingsNav("acme"));
  const general = links.find((l) => l.label === "General")!;
  const webhooks = links.find((l) => l.label === "Webhooks")!;

  it("matches General only on the exact settings index", () => {
    expect(isSettingsLinkActive(general, "/orgs/acme/settings")).toBe(true);
    expect(isSettingsLinkActive(general, "/orgs/acme/settings/members")).toBe(false);
  });

  it("keeps a section active on its nested detail pages", () => {
    expect(isSettingsLinkActive(webhooks, "/orgs/acme/settings/webhooks")).toBe(true);
    expect(isSettingsLinkActive(webhooks, "/orgs/acme/settings/webhooks/ep_123")).toBe(true);
  });

  it("does not match sibling prefixes or a null pathname", () => {
    expect(isSettingsLinkActive(webhooks, "/orgs/acme/settings/webhooks-archive")).toBe(false);
    expect(isSettingsLinkActive(webhooks, null)).toBe(false);
  });
});
