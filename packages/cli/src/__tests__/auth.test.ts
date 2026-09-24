import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Meterwise } from "@saas/sdk";

import { loginFlow } from "../auth/login.js";
import { logoutFlow } from "../auth/logout.js";
import { whoamiFlow } from "../auth/whoami.js";
import { ContextStore } from "../context/store.js";
import { MissingAuthError } from "../errors.js";
import { captureFetch, envelope, jsonResponse, MemoryTokenStore } from "./helpers.js";

const ORG_LIST = envelope({
  organizations: [
    { id: "org_1", name: "Acme", slug: "acme", createdAt: "2025-01-01T00:00:00Z" },
  ],
});

describe("login (token-paste)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-auth-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("validates the token via SDK and persists", async () => {
    const { fetch } = captureFetch(() => jsonResponse(ORG_LIST));
    const tokenStore = new MemoryTokenStore();
    const ctx = new ContextStore({ configDir: dir });
    const stdout: string[] = [];

    await loginFlow({
      apiUrl: "https://api.test",
      token: "tok_paste",
      outputMode: "json",
      tokenStore,
      contextStore: ctx,
      readToken: async () => "should-not-be-called",
      stdout: (line) => stdout.push(line),
      sdkFactory: (baseUrl, token) =>
        new Meterwise({ baseUrl, auth: { kind: "bearer", token }, fetch }),
    });

    const cred = await tokenStore.load();
    expect(cred).toEqual({ apiUrl: "https://api.test", token: "tok_paste" });
    const cliCtx = await ctx.load();
    expect(cliCtx.lastApiUrl).toBe("https://api.test");
    expect(JSON.parse(stdout[0] ?? "")).toEqual({
      apiUrl: "https://api.test",
      organizations: 1,
    });
  });

  it("rejects empty tokens", async () => {
    const tokenStore = new MemoryTokenStore();
    const ctx = new ContextStore({ configDir: dir });
    await expect(
      loginFlow({
        apiUrl: "https://api.test",
        token: "",
        outputMode: "human",
        tokenStore,
        contextStore: ctx,
        readToken: async () => "",
        stdout: () => undefined,
      }),
    ).rejects.toThrow(/token cannot be empty/);
  });

  it("rejects empty api-url", async () => {
    const tokenStore = new MemoryTokenStore();
    const ctx = new ContextStore({ configDir: dir });
    await expect(
      loginFlow({
        apiUrl: "   ",
        token: "tok",
        outputMode: "human",
        tokenStore,
        contextStore: ctx,
        readToken: async () => "tok",
        stdout: () => undefined,
      }),
    ).rejects.toThrow(/api-url cannot be empty/);
  });

  it("propagates UnauthenticatedError on 401 (caller maps to friendly msg)", async () => {
    const { fetch } = captureFetch(() =>
      jsonResponse(
        {
          error: {
            code: "unauthenticated",
            message: "bad token",
            details: {},
            requestId: "req_x",
          },
        },
        { status: 401 },
      ),
    );
    const tokenStore = new MemoryTokenStore();
    const ctx = new ContextStore({ configDir: dir });
    await expect(
      loginFlow({
        apiUrl: "https://api.test",
        token: "tok_bad",
        outputMode: "human",
        tokenStore,
        contextStore: ctx,
        readToken: async () => "tok_bad",
        stdout: () => undefined,
        sdkFactory: (baseUrl, token) =>
          new Meterwise({ baseUrl, auth: { kind: "bearer", token }, fetch }),
      }),
    ).rejects.toMatchObject({ name: "UnauthenticatedError" });
    // Token should NOT have been persisted on auth failure.
    expect(await tokenStore.load()).toBeNull();
  });
});

describe("whoami", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-who-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("throws MissingAuthError when no credential is stored", async () => {
    const tokenStore = new MemoryTokenStore();
    const ctx = new ContextStore({ configDir: dir });
    await expect(
      whoamiFlow({
        outputMode: "human",
        tokenStore,
        contextStore: ctx,
        stdout: () => undefined,
      }),
    ).rejects.toBeInstanceOf(MissingAuthError);
  });

  it("emits identity + active org via SDK factory", async () => {
    const tokenStore = new MemoryTokenStore({
      apiUrl: "https://api.test",
      token: "tok",
    });
    const ctx = new ContextStore({ configDir: dir });
    await ctx.setActiveOrg("org_1");

    const { fetch } = captureFetch(() => jsonResponse(ORG_LIST));
    const stdout: string[] = [];
    await whoamiFlow({
      outputMode: "json",
      tokenStore,
      contextStore: ctx,
      stdout: (line) => stdout.push(line),
      sdkFactory: (baseUrl, token) =>
        new Meterwise({ baseUrl, auth: { kind: "bearer", token }, fetch }),
    });
    expect(JSON.parse(stdout[0] ?? "")).toEqual({
      apiUrl: "https://api.test",
      activeOrgId: "org_1",
      organizations: 1,
    });
  });
});

describe("logout", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-logout-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("clears credentials and context", async () => {
    const tokenStore = new MemoryTokenStore({ apiUrl: "u", token: "t" });
    const ctx = new ContextStore({ configDir: dir });
    await ctx.setActiveOrg("org_1");
    const stdout: string[] = [];
    await logoutFlow({
      outputMode: "json",
      tokenStore,
      contextStore: ctx,
      stdout: (line) => stdout.push(line),
    });
    expect(await tokenStore.load()).toBeNull();
    expect(await ctx.load()).toEqual({});
    expect(JSON.parse(stdout[0] ?? "")).toEqual({ ok: true });
  });
});
