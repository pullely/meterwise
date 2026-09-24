// Tests for PX3 — `meterwise notifications preferences [set]`.
//
// Same fake-SDK injection harness as security-events.test.ts: the commands
// are thin adapters over `sdk.notifications.getPreferences/updatePreferences`
// (+ `sdk.auth.getProfile` for the subject id on `set`), so SDK-layer fakes
// let us assert call shapes without modelling the wire envelope.
//
// Scope note: org context is required (resolveOrgId with --org override);
// subject scope is the bearer's actor — the facade pins it server-side, and
// `set` resolves `subjectId` from the profile to send an honest request.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Meterwise, NotificationPreference } from "@saas/sdk";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { MemoryTokenStore } from "./helpers.js";

function pref(categories: NotificationPreference["categories"]): NotificationPreference {
  return {
    subjectKind: "user",
    subjectId: "usr_me",
    orgId: "org_1",
    channel: "email",
    categories,
    updatedAt: "2026-06-11T00:00:00.000Z",
  };
}

interface Cap {
  stdout: string[];
  stderr: string[];
  getCalls: unknown[];
  updateCalls: unknown[];
}

async function withHarness(
  fn: (h: {
    cap: Cap;
    runArgv: (argv: string[]) => Promise<{ exitCode: number }>;
  }) => Promise<void>,
  opts: { stored?: NotificationPreference[] } = {},
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-px3-"));
  try {
    const cap: Cap = { stdout: [], stderr: [], getCalls: [], updateCalls: [] };
    const tokenStore = new MemoryTokenStore({ apiUrl: "https://api.test", token: "tok" });
    const contextStore = new ContextStore({ configDir: dir });

    const getPreferences = vi.fn(async (q: unknown) => {
      cap.getCalls.push(q);
      return { preferences: opts.stored ?? [] };
    });
    const updatePreferences = vi.fn(async (body: { categories: NotificationPreference["categories"] }) => {
      cap.updateCalls.push(body);
      return { preference: pref(body.categories) };
    });
    const getProfile = vi.fn(async () => ({
      user: { id: "usr_me", email: "me@test.com", displayName: null },
    }));

    const fakeSdk = {
      notifications: { getPreferences, updatePreferences },
      auth: { getProfile },
    } as unknown as Meterwise;

    const runArgv = (argv: string[]): Promise<{ exitCode: number }> =>
      runCli(argv, {
        stdout: (l) => cap.stdout.push(l),
        stderr: (l) => cap.stderr.push(l),
        tokenStore,
        contextStore,
        sdkFactory: () => fakeSdk,
      });

    await fn({ cap, runArgv });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("commands — notifications preferences", () => {
  it("get: defaults every category to enabled when no row exists", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["notifications", "preferences", "--org", "org_1"]);
      expect(r.exitCode).toBe(0);
      expect(cap.getCalls[0]).toEqual({ orgId: "org_1" });
      const out = cap.stdout.join("\n");
      for (const c of ["invitation", "billing", "security", "support", "product"]) {
        expect(out).toContain(c);
      }
      expect(out).not.toContain("false");
    });
  });

  it("get --output=json: emits effective category map honoring stored false", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "notifications",
          "preferences",
          "--org",
          "org_1",
          "--output=json",
        ]);
        expect(r.exitCode).toBe(0);
        const doc = JSON.parse(cap.stdout.join("\n")) as {
          categories: Record<string, boolean>;
        };
        expect(doc.categories.billing).toBe(false);
        expect(doc.categories.product).toBe(true);
      },
      { stored: [pref({ billing: false, product: null })] },
    );
  });

  it("set: flips one category, keeps the rest explicit, subject from profile", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "notifications",
          "preferences",
          "set",
          "--org",
          "org_1",
          "--category=product",
          "--enabled=false",
        ]);
        expect(r.exitCode).toBe(0);
        expect(cap.updateCalls).toHaveLength(1);
        expect(cap.updateCalls[0]).toEqual({
          orgId: "org_1",
          subjectKind: "user",
          subjectId: "usr_me",
          channel: "email",
          categories: {
            invitation: true,
            billing: false,
            security: true,
            support: true,
            product: false,
          },
        });
      },
      { stored: [pref({ billing: false })] },
    );
  });

  it("set: rejects an unknown category with a usage error (exit 2)", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "notifications",
        "preferences",
        "set",
        "--org",
        "org_1",
        "--category=spam",
        "--enabled=false",
      ]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toContain("--category");
    });
  });

  it("set: rejects a non-boolean --enabled with a usage error (exit 2)", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "notifications",
        "preferences",
        "set",
        "--org",
        "org_1",
        "--category=billing",
        "--enabled=maybe",
      ]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toContain("--enabled");
    });
  });
});
