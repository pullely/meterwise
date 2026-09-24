import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { Meterwise } from "@saas/sdk";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { captureFetch, envelope, jsonResponse, MemoryTokenStore } from "./helpers.js";

const ORG_LIST = envelope({
  organizations: [
    { id: "org_1", name: "Acme", slug: "acme", createdAt: "2025-01-01T00:00:00Z" },
    { id: "org_2", name: "Beta", slug: "beta", createdAt: "2025-02-01T00:00:00Z" },
  ],
});

const ORG_GET = envelope({
  organization: {
    id: "org_1",
    name: "Acme",
    slug: "acme",
    createdAt: "2025-01-01T00:00:00Z",
  },
});

const MEMBERS = envelope({
  members: [
    {
      id: "mem_1",
      subjectType: "user",
      subjectId: "usr_a",
      status: "active",
      joinedAt: "2025-01-01T00:00:00Z",
      roles: [{ role: "owner", scopeKind: "organization" }],
    },
  ],
});

const PROJECTS = envelope({
  projects: [
    {
      id: "prj_1",
      orgId: "org_1",
      name: "Web",
      slug: "web",
      status: "active",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      archivedAt: null,
    },
  ],
});

interface Cap {
  stdout: string[];
  stderr: string[];
  fetchCalls: { url: string; init: RequestInit }[];
}

async function withHarness(
  fn: (h: {
    cap: Cap;
    tokenStore: MemoryTokenStore;
    contextStore: ContextStore;
    runArgv: (argv: string[]) => Promise<{ exitCode: number }>;
  }) => Promise<void>,
  options: {
    response: () => Response;
    activeOrgId?: string;
    storedCred?: { apiUrl: string; token: string };
  },
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-cmd-"));
  try {
    const cap: Cap = { stdout: [], stderr: [], fetchCalls: [] };
    const fetchHarness = captureFetch(options.response);
    cap.fetchCalls = fetchHarness.calls;
    const tokenStore = new MemoryTokenStore(
      options.storedCred ?? { apiUrl: "https://api.test", token: "tok" },
    );
    const contextStore = new ContextStore({ configDir: dir });
    if (options.activeOrgId) await contextStore.setActiveOrg(options.activeOrgId);

    const runArgv = (argv: string[]): Promise<{ exitCode: number }> =>
      runCli(argv, {
        stdout: (l) => cap.stdout.push(l),
        stderr: (l) => cap.stderr.push(l),
        tokenStore,
        contextStore,
        sdkFactory: (baseUrl, token) =>
          new Meterwise({
            baseUrl,
            auth: { kind: "bearer", token },
            fetch: fetchHarness.fetch,
          }),
      });

    await fn({ cap, tokenStore, contextStore, runArgv });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("commands — org list", () => {
  it("hits /v1/organizations and prints a table (human)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["org", "list"]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls[0]?.url).toBe("https://api.test/v1/organizations");
        const text = cap.stdout.join("\n");
        expect(text).toContain("Acme");
        expect(text).toContain("Beta");
        expect(text).toMatch(/active\s+id\s+name\s+slug/);
      },
      { response: () => jsonResponse(ORG_LIST), activeOrgId: "org_1" },
    );
  });

  it("emits stable JSON shape when --output=json", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["org", "list", "--output=json"]);
        expect(r.exitCode).toBe(0);
        const parsed = JSON.parse(cap.stdout[0] ?? "");
        expect(parsed).toEqual({
          activeOrgId: "org_2",
          organizations: ORG_LIST.data.organizations,
        });
      },
      { response: () => jsonResponse(ORG_LIST), activeOrgId: "org_2" },
    );
  });
});

describe("commands — org use", () => {
  it("validates the org via SDK then writes config.json", async () => {
    await withHarness(
      async ({ cap, contextStore, runArgv }) => {
        const r = await runArgv(["org", "use", "org_1"]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls[0]?.url).toBe(
          "https://api.test/v1/organizations/org_1",
        );
        expect((await contextStore.load()).activeOrgId).toBe("org_1");
      },
      { response: () => jsonResponse(ORG_GET) },
    );
  });

  it("missing arg → usage exit 2", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["org", "use"]);
        expect(r.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/usage/);
      },
      { response: () => jsonResponse(ORG_GET) },
    );
  });
});

describe("commands — org members", () => {
  it("requires an active org context", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["org", "members"]);
        expect(r.exitCode).toBe(5);
        expect(cap.stderr.join("\n")).toMatch(/no active organization/);
      },
      { response: () => jsonResponse(MEMBERS) },
    );
  });

  it("hits the org-scoped members path when context is set", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["org", "members"]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls[0]?.url).toBe(
          "https://api.test/v1/organizations/org_1/members",
        );
      },
      { response: () => jsonResponse(MEMBERS), activeOrgId: "org_1" },
    );
  });

  it("JSON mode round-trips the SDK response", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["org", "members", "--output=json"]);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(cap.stdout[0] ?? "")).toEqual(MEMBERS.data);
      },
      { response: () => jsonResponse(MEMBERS), activeOrgId: "org_1" },
    );
  });
});

describe("commands — project list", () => {
  it("hits the org-scoped projects path", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["project", "list"]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls[0]?.url).toBe(
          "https://api.test/v1/organizations/org_1/projects",
        );
        expect(cap.stdout.join("\n")).toContain("Web");
      },
      { response: () => jsonResponse(PROJECTS), activeOrgId: "org_1" },
    );
  });

  it("requires org context", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["project", "list"]);
        expect(r.exitCode).toBe(5);
        expect(cap.stderr.join("\n")).toMatch(/no active organization/);
      },
      { response: () => jsonResponse(PROJECTS) },
    );
  });
});

describe("commands — auth gating", () => {
  it("returns exit 3 when no credential is stored", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-cmd-"));
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const r = await runCli(["org", "list"], {
        stdout: (l) => stdout.push(l),
        stderr: (l) => stderr.push(l),
        tokenStore: new MemoryTokenStore(),
        contextStore: new ContextStore({ configDir: dir }),
      });
      expect(r.exitCode).toBe(3);
      expect(stderr.join("\n")).toMatch(/not logged in/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
