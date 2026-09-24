import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContextStore } from "../context/store.js";
import { resolveConfigDir } from "../config-paths.js";

describe("ContextStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-ctx-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns empty context when file is missing", async () => {
    const ctx = new ContextStore({ configDir: dir });
    expect(await ctx.load()).toEqual({});
  });

  it("setActiveOrg writes config.json", async () => {
    const ctx = new ContextStore({ configDir: dir });
    await ctx.setActiveOrg("org_1");
    const loaded = await ctx.load();
    expect(loaded.activeOrgId).toBe("org_1");
  });

  it("setLastApiUrl writes alongside other context fields", async () => {
    const ctx = new ContextStore({ configDir: dir });
    await ctx.setActiveOrg("org_1");
    await ctx.setLastApiUrl("https://api.test");
    const loaded = await ctx.load();
    expect(loaded).toEqual({ activeOrgId: "org_1", lastApiUrl: "https://api.test" });
  });

  it("clear() removes the file (idempotent)", async () => {
    const ctx = new ContextStore({ configDir: dir });
    await ctx.setActiveOrg("org_x");
    await ctx.clear();
    expect(await ctx.load()).toEqual({});
    await ctx.clear();
    expect(await ctx.load()).toEqual({});
  });

  it("ignores malformed JSON without throwing", async () => {
    const ctx = new ContextStore({ configDir: dir });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "config.json"), "not json");
    expect(await ctx.load()).toEqual({});
  });
});

describe("resolveConfigDir", () => {
  it("respects METERWISE_CONFIG_DIR override", () => {
    const prev = process.env["METERWISE_CONFIG_DIR"];
    process.env["METERWISE_CONFIG_DIR"] = "/tmp/cli-override";
    try {
      expect(resolveConfigDir()).toBe("/tmp/cli-override");
    } finally {
      if (prev === undefined) delete process.env["METERWISE_CONFIG_DIR"];
      else process.env["METERWISE_CONFIG_DIR"] = prev;
    }
  });
});
