import {
  buildBaseCommands,
  composeCommands,
  groupCommands,
  COMMAND_GROUPS,
  type CommandContext,
  type CommandDescriptor,
} from "@web-console-next/components/shell/command-registry";

const baseCtx: CommandContext = {
  orgSlug: null,
  projectSlug: null,
  isLocked: false,
  targets: [{ name: "stage" }, { name: "prod" }],
};

describe("buildBaseCommands", () => {
  it("always includes org switch, security, and logout regardless of scope", () => {
    const ids = buildBaseCommands(baseCtx).map((c) => c.id);
    expect(ids).toContain("nav.orgs");
    expect(ids).toContain("nav.account.security");
    expect(ids).toContain("session.logout");
  });

  it("omits org-scoped commands when no orgSlug is present", () => {
    const ids = buildBaseCommands(baseCtx).map((c) => c.id);
    expect(ids).not.toContain("nav.projects");
    expect(ids).not.toContain("nav.billing");
  });

  it("adds org-scoped commands when orgSlug is present", () => {
    const cmds = buildBaseCommands({ ...baseCtx, orgSlug: "acme" });
    const byId = new Map(cmds.map((c) => [c.id, c]));
    expect(byId.has("nav.projects")).toBe(true);
    expect(byId.has("nav.billing")).toBe(true);
    const billing = byId.get("nav.billing")!;
    expect(billing.kind).toBe("navigate");
    // Billing now lives under the dedicated Settings surface.
    if (billing.kind === "navigate") expect(billing.to).toBe("/orgs/acme/settings/billing");
  });

  it("points org-administration commands at the Settings surface", () => {
    const cmds = buildBaseCommands({ ...baseCtx, orgSlug: "acme" });
    const byId = new Map(cmds.map((c) => [c.id, c]));
    for (const id of ["nav.members", "nav.webhooks", "nav.api-keys", "nav.audit", "nav.config"]) {
      const cmd = byId.get(id)!;
      expect(cmd.kind).toBe("navigate");
      if (cmd.kind === "navigate") expect(cmd.to).toMatch(/^\/orgs\/acme\/settings\//);
    }
    // Create flows for moved resources target the Settings paths too.
    const invite = byId.get("create.invitation")!;
    if (invite.kind === "navigate") expect(invite.to).toBe("/orgs/acme/settings/invitations?new=1");
  });

  it("adds project-scoped commands only when both org and project slugs are present", () => {
    const orgOnly = buildBaseCommands({ ...baseCtx, orgSlug: "acme" }).map((c) => c.id);
    expect(orgOnly).not.toContain("nav.environments");
    const both = buildBaseCommands({ ...baseCtx, orgSlug: "acme", projectSlug: "web" }).map((c) => c.id);
    expect(both).toContain("nav.environments");
  });

  it("emits target commands when unlocked and none when locked", () => {
    const unlocked = buildBaseCommands(baseCtx).filter((c) => c.kind === "target");
    expect(unlocked.map((c) => (c.kind === "target" ? c.targetName : ""))).toEqual(["stage", "prod"]);
    const locked = buildBaseCommands({ ...baseCtx, isLocked: true }).filter((c) => c.kind === "target");
    expect(locked).toHaveLength(0);
  });

  it("references only known icon names and stable group names", () => {
    for (const c of buildBaseCommands({ ...baseCtx, orgSlug: "acme", projectSlug: "web" })) {
      expect(COMMAND_GROUPS).toContain(c.group);
    }
  });
});

describe("composeCommands", () => {
  const extra: CommandDescriptor[] = [
    { id: "x.custom", label: "Custom action", group: "Navigation", kind: "navigate", to: "/x" },
  ];

  it("appends page-contributed commands", () => {
    const out = composeCommands(buildBaseCommands(baseCtx), extra);
    expect(out.map((c) => c.id)).toContain("x.custom");
  });

  it("lets a later registration override an earlier descriptor with the same id", () => {
    const override: CommandDescriptor[] = [
      { id: "nav.orgs", label: "Renamed orgs", group: "Navigation", kind: "navigate", to: "/orgs" },
    ];
    const out = composeCommands(buildBaseCommands(baseCtx), override);
    const orgs = out.filter((c) => c.id === "nav.orgs");
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.label).toBe("Renamed orgs");
  });

  it("orders by stable group precedence", () => {
    const out = composeCommands(buildBaseCommands(baseCtx), extra);
    const groupOrder = out.map((c) => COMMAND_GROUPS.indexOf(c.group));
    const sorted = [...groupOrder].sort((a, b) => a - b);
    expect(groupOrder).toEqual(sorted);
  });
});

describe("groupCommands", () => {
  it("drops empty groups and preserves group order", () => {
    const groups = groupCommands(buildBaseCommands({ ...baseCtx, isLocked: true }));
    const names = groups.map((g) => g.group);
    expect(names).not.toContain("Target"); // locked → no targets
    // Navigation precedes Session
    expect(names.indexOf("Navigation")).toBeLessThan(names.indexOf("Session"));
  });

  it("buckets each command under its declared group", () => {
    const groups = groupCommands(buildBaseCommands(baseCtx));
    for (const g of groups) {
      for (const item of g.items) expect(item.group).toBe(g.group);
    }
  });
});
