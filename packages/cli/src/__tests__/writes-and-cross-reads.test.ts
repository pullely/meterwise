// Tests for Task 0101 — write commands (org invite, project create, env
// create, api-key create, webhook create) and cross-resource reads (usage
// summary, billing summary, audit list).
//
// The harness mirrors `commands.test.ts`: a captured-fetch `Meterwise`
// is injected via `sdkFactory`, a `MemoryTokenStore` carries the bearer
// token, and a temp-dir `ContextStore` carries the active-org. We assert
// against the recorded fetch URLs/methods/headers/body, the formatted
// stdout, and the CLI exit code.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { Meterwise } from "@saas/sdk";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { MemoryTokenStore, envelope, jsonResponse } from "./helpers.js";

// ---- response fixtures ----------------------------------------------------

const INVITATION_CREATED = envelope({
  invitation: {
    id: "inv_1",
    email: "alice@example.com",
    role: "admin",
    status: "pending",
    invitedBy: "usr_a",
    expiresAt: "2025-12-31T00:00:00Z",
    createdAt: "2025-01-01T00:00:00Z",
    acceptedAt: null,
    revokedAt: null,
  },
});

const PROJECT_CREATED = envelope({
  project: {
    id: "prj_new",
    orgId: "org_1",
    name: "Edge",
    slug: "edge",
    status: "active",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    archivedAt: null,
  },
});

const ENV_CREATED = envelope({
  environment: {
    id: "env_new",
    orgId: "org_1",
    projectId: "prj_1",
    name: "staging",
    slug: "staging",
    status: "active",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    archivedAt: null,
  },
});

const API_KEY_CREATED = envelope({
  apiKey: {
    id: "ak_new",
    label: "ci",
    prefix: "sp_live_abc",
    secret: "sp_live_abc.SUPERSECRET",
    createdAt: "2025-01-01T00:00:00Z",
    expiresAt: null,
    servicePrincipal: {
      id: "sp_1",
      role: "viewer",
      kind: "api_key",
    },
  },
});

const WEBHOOK_ENDPOINT_CREATED = envelope({
  endpoint: {
    id: "whe_new",
    orgId: "org_1",
    projectId: null,
    url: "https://example.com/hook",
    secret: "whsec_x",
    status: "active",
    description: null,
    metadata: {},
    createdAt: "2025-01-01T00:00:00Z",
  },
});

const WEBHOOK_SUBSCRIPTION_CREATED = envelope({
  subscription: {
    id: "whs_new",
    endpointId: "whe_new",
    eventType: "project.created",
    createdAt: "2025-01-01T00:00:00Z",
  },
});

const USAGE_SUMMARY = envelope({
  metric: "requests",
  rollups: [
    {
      bucketStart: "2025-01-01T00:00:00Z",
      bucketType: "day",
      quantity: 100,
      recordCount: 50,
      projectId: null,
      environmentId: null,
    },
  ],
});

const BILLING_SUMMARY = envelope({
  customer: { id: "cus_1", orgId: "org_1", externalId: "cus_stripe", createdAt: "2025-01-01T00:00:00Z" },
  activeSubscription: { id: "sub_1", status: "active", planId: "plan_pro", currentPeriodEnd: "2025-12-31T00:00:00Z" },
  plan: { id: "plan_pro", name: "Pro", currency: "usd", interval: "month", amount: 9900 },
  entitlements: [
    { feature: "max_projects", limit: 10, used: 2 },
  ],
});

const AUDIT_PAGE_1 = {
  data: {
    auditEntries: [
      {
        id: "ae_1",
        eventId: "evt_1",
        orgId: "org_1",
        projectId: null,
        environmentId: null,
        actorType: "user",
        actorId: "usr_a",
        eventType: "org.member.invited",
        source: "api-edge",
        category: "membership",
        description: "Invited alice",
        subject: { kind: "user", id: "usr_a", name: null },
        occurredAt: "2025-01-01T00:00:00Z",
        requestId: "req_1",
        correlationId: null,
        payload: {},
      },
    ],
  },
  meta: { requestId: "req_1", cursor: "cur_2" },
};

const AUDIT_PAGE_2 = {
  data: {
    auditEntries: [
      {
        id: "ae_2",
        eventId: "evt_2",
        orgId: "org_1",
        projectId: null,
        environmentId: null,
        actorType: "user",
        actorId: "usr_a",
        eventType: "project.created",
        source: "api-edge",
        category: "project",
        description: "Created Edge",
        subject: { kind: "project", id: "prj_new", name: "Edge" },
        occurredAt: "2025-01-02T00:00:00Z",
        requestId: "req_2",
        correlationId: null,
        payload: {},
      },
    ],
  },
  meta: { requestId: "req_2", cursor: null as string | null },
};

// ---- harness --------------------------------------------------------------

interface Cap {
  stdout: string[];
  stderr: string[];
  fetchCalls: { url: string; init: RequestInit }[];
}

interface ResponderArgs {
  url: string;
  init: RequestInit;
}

async function withHarness(
  fn: (h: {
    cap: Cap;
    runArgv: (argv: string[]) => Promise<{ exitCode: number }>;
  }) => Promise<void>,
  options: {
    responder: (args: ResponderArgs) => Response;
    activeOrgId?: string;
    storedCred?: { apiUrl: string; token: string } | null;
  },
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-task0101-"));
  try {
    const cap: Cap = { stdout: [], stderr: [], fetchCalls: [] };
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      cap.fetchCalls.push({ url, init: init ?? {} });
      return options.responder({ url, init: init ?? {} }).clone();
    };

    const tokenStore =
      options.storedCred === null
        ? new MemoryTokenStore()
        : new MemoryTokenStore(
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
            fetch: fetchFn,
          }),
      });

    await fn({ cap, runArgv });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function pickHeader(init: RequestInit, name: string): string | null {
  const h = init.headers;
  if (h === undefined) return null;
  if (h instanceof Headers) return h.get(name);
  if (Array.isArray(h)) {
    for (const [k, v] of h) {
      if (k.toLowerCase() === name.toLowerCase()) return v;
    }
    return null;
  }
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === name.toLowerCase()) return String(v);
  }
  return null;
}

// ---- org invite -----------------------------------------------------------

describe("commands — org invite", () => {
  it("POSTs to /v1/organizations/:orgId/invitations with the email + default role", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["org", "invite", "alice@example.com"]);
        expect(r.exitCode).toBe(0);
        const call = cap.fetchCalls[0]!;
        expect(call.url).toBe("https://api.test/v1/organizations/org_1/invitations");
        expect(call.init.method).toBe("POST");
        expect(JSON.parse(String(call.init.body))).toEqual({
          email: "alice@example.com",
          role: "viewer",
        });
        expect(cap.stdout.join("\n")).toContain("inv_1");
      },
      { responder: () => jsonResponse(INVITATION_CREATED), activeOrgId: "org_1" },
    );
  });

  it("forwards --idempotency-key verbatim as the Idempotency-Key header", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "org",
          "invite",
          "alice@example.com",
          "--role=admin",
          "--idempotency-key=abc-123",
        ]);
        expect(r.exitCode).toBe(0);
        const call = cap.fetchCalls[0]!;
        expect(pickHeader(call.init, "idempotency-key")).toBe("abc-123");
        expect(JSON.parse(String(call.init.body))).toEqual({
          email: "alice@example.com",
          role: "admin",
        });
      },
      { responder: () => jsonResponse(INVITATION_CREATED), activeOrgId: "org_1" },
    );
  });

  it("does NOT auto-mint an Idempotency-Key when the flag is absent", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["org", "invite", "alice@example.com"]);
        expect(r.exitCode).toBe(0);
        expect(pickHeader(cap.fetchCalls[0]!.init, "idempotency-key")).toBeNull();
      },
      { responder: () => jsonResponse(INVITATION_CREATED), activeOrgId: "org_1" },
    );
  });

  it("--org=ORG_ID overrides the active-org context", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "org",
          "invite",
          "alice@example.com",
          "--org=org_99",
        ]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls[0]!.url).toBe(
          "https://api.test/v1/organizations/org_99/invitations",
        );
      },
      { responder: () => jsonResponse(INVITATION_CREATED), activeOrgId: "org_1" },
    );
  });

  it("--org works even with no persisted active-org context", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "org",
          "invite",
          "alice@example.com",
          "--org=org_solo",
        ]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls[0]!.url).toContain("/organizations/org_solo/");
      },
      { responder: () => jsonResponse(INVITATION_CREATED) },
    );
  });

  it("missing org context (no --org and no active) → exit 5", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["org", "invite", "alice@example.com"]);
        expect(r.exitCode).toBe(5);
        expect(cap.stderr.join("\n")).toMatch(/no active organization/i);
      },
      { responder: () => jsonResponse(INVITATION_CREATED) },
    );
  });

  it("missing email arg → usage exit 2", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["org", "invite"]);
        expect(r.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/usage/);
      },
      { responder: () => jsonResponse(INVITATION_CREATED), activeOrgId: "org_1" },
    );
  });

  it("emits the SDK response shape verbatim in --output=json", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "org",
          "invite",
          "alice@example.com",
          "--output=json",
        ]);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(cap.stdout[0] ?? "")).toEqual(INVITATION_CREATED.data);
      },
      { responder: () => jsonResponse(INVITATION_CREATED), activeOrgId: "org_1" },
    );
  });
});

// ---- project create -------------------------------------------------------

describe("commands — project create", () => {
  it("POSTs to /v1/organizations/:orgId/projects with the name", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["project", "create", "Edge"]);
        expect(r.exitCode).toBe(0);
        const call = cap.fetchCalls[0]!;
        expect(call.url).toBe("https://api.test/v1/organizations/org_1/projects");
        expect(call.init.method).toBe("POST");
        expect(JSON.parse(String(call.init.body))).toEqual({ name: "Edge" });
      },
      { responder: () => jsonResponse(PROJECT_CREATED), activeOrgId: "org_1" },
    );
  });

  it("forwards --idempotency-key verbatim", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "project",
          "create",
          "Edge",
          "--idempotency-key=xyz",
        ]);
        expect(r.exitCode).toBe(0);
        expect(pickHeader(cap.fetchCalls[0]!.init, "idempotency-key")).toBe("xyz");
      },
      { responder: () => jsonResponse(PROJECT_CREATED), activeOrgId: "org_1" },
    );
  });

  it("does NOT honour --org override (active-org only)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "project",
          "create",
          "Edge",
          "--org=org_99",
        ]);
        expect(r.exitCode).toBe(0);
        // Org from context, NOT from flag.
        expect(cap.fetchCalls[0]!.url).toContain("/organizations/org_1/projects");
      },
      { responder: () => jsonResponse(PROJECT_CREATED), activeOrgId: "org_1" },
    );
  });

  it("missing org context → exit 5", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["project", "create", "Edge"]);
        expect(r.exitCode).toBe(5);
        expect(cap.stderr.join("\n")).toMatch(/no active organization/i);
      },
      { responder: () => jsonResponse(PROJECT_CREATED) },
    );
  });

  it("missing name → usage exit 2", async () => {
    await withHarness(
      async ({ runArgv }) => {
        const r = await runArgv(["project", "create"]);
        expect(r.exitCode).toBe(2);
      },
      { responder: () => jsonResponse(PROJECT_CREATED), activeOrgId: "org_1" },
    );
  });

  it("missing auth → exit 3", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["project", "create", "Edge"]);
        expect(r.exitCode).toBe(3);
        expect(cap.stderr.join("\n")).toMatch(/not logged in/);
      },
      {
        responder: () => jsonResponse(PROJECT_CREATED),
        activeOrgId: "org_1",
        storedCred: null,
      },
    );
  });
});

// ---- env create -----------------------------------------------------------

describe("commands — env create", () => {
  it("POSTs to /v1/organizations/:orgId/projects/:projectId/environments via transport.request", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["env", "create", "prj_1", "staging"]);
        expect(r.exitCode).toBe(0);
        const call = cap.fetchCalls[0]!;
        expect(call.url).toBe(
          "https://api.test/v1/organizations/org_1/projects/prj_1/environments",
        );
        expect(call.init.method).toBe("POST");
        expect(JSON.parse(String(call.init.body))).toEqual({ name: "staging" });
      },
      { responder: () => jsonResponse(ENV_CREATED), activeOrgId: "org_1" },
    );
  });

  it("forwards --idempotency-key verbatim", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "env",
          "create",
          "prj_1",
          "staging",
          "--idempotency-key=env-key-1",
        ]);
        expect(r.exitCode).toBe(0);
        expect(pickHeader(cap.fetchCalls[0]!.init, "idempotency-key")).toBe(
          "env-key-1",
        );
      },
      { responder: () => jsonResponse(ENV_CREATED), activeOrgId: "org_1" },
    );
  });

  it("missing project-id or name → usage exit 2", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r1 = await runArgv(["env", "create"]);
        expect(r1.exitCode).toBe(2);
        const r2 = await runArgv(["env", "create", "prj_1"]);
        expect(r2.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/usage/);
      },
      { responder: () => jsonResponse(ENV_CREATED), activeOrgId: "org_1" },
    );
  });

  it("missing org context → exit 5", async () => {
    await withHarness(
      async ({ runArgv }) => {
        const r = await runArgv(["env", "create", "prj_1", "staging"]);
        expect(r.exitCode).toBe(5);
      },
      { responder: () => jsonResponse(ENV_CREATED) },
    );
  });

  it("emits a record with id/projectId/name/slug/status in human mode", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["env", "create", "prj_1", "staging"]);
        expect(r.exitCode).toBe(0);
        const text = cap.stdout.join("\n");
        expect(text).toContain("env_new");
        expect(text).toContain("staging");
        expect(text).toContain("prj_1");
      },
      { responder: () => jsonResponse(ENV_CREATED), activeOrgId: "org_1" },
    );
  });
});

// ---- api-key create -------------------------------------------------------

describe("commands — api-key create", () => {
  it("POSTs to /v1/organizations/:orgId/api-keys with label + default role", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["api-key", "create", "ci"]);
        expect(r.exitCode).toBe(0);
        const call = cap.fetchCalls[0]!;
        expect(call.url).toBe("https://api.test/v1/organizations/org_1/api-keys");
        expect(JSON.parse(String(call.init.body))).toEqual({
          label: "ci",
          role: "viewer",
        });
      },
      { responder: () => jsonResponse(API_KEY_CREATED), activeOrgId: "org_1" },
    );
  });

  it("--scope=builder is forwarded as the role field", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["api-key", "create", "ci", "--scope=builder"]);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(String(cap.fetchCalls[0]!.init.body))).toEqual({
          label: "ci",
          role: "builder",
        });
      },
      { responder: () => jsonResponse(API_KEY_CREATED), activeOrgId: "org_1" },
    );
  });

  it("forwards --idempotency-key verbatim", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "api-key",
          "create",
          "ci",
          "--idempotency-key=k-1",
        ]);
        expect(r.exitCode).toBe(0);
        expect(pickHeader(cap.fetchCalls[0]!.init, "idempotency-key")).toBe("k-1");
      },
      { responder: () => jsonResponse(API_KEY_CREATED), activeOrgId: "org_1" },
    );
  });

  it("surfaces the one-time secret in human output", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["api-key", "create", "ci"]);
        expect(r.exitCode).toBe(0);
        expect(cap.stdout.join("\n")).toContain("sp_live_abc.SUPERSECRET");
      },
      { responder: () => jsonResponse(API_KEY_CREATED), activeOrgId: "org_1" },
    );
  });

  it("missing label → usage exit 2", async () => {
    await withHarness(
      async ({ runArgv }) => {
        const r = await runArgv(["api-key", "create"]);
        expect(r.exitCode).toBe(2);
      },
      { responder: () => jsonResponse(API_KEY_CREATED), activeOrgId: "org_1" },
    );
  });
});

// ---- webhook create -------------------------------------------------------

describe("commands — webhook create", () => {
  it("POSTs to /v1/organizations/:orgId/webhooks/endpoints with the URL", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "webhook",
          "create",
          "https://example.com/hook",
        ]);
        expect(r.exitCode).toBe(0);
        const call = cap.fetchCalls[0]!;
        expect(call.url).toBe(
          "https://api.test/v1/organizations/org_1/webhooks/endpoints",
        );
        expect(JSON.parse(String(call.init.body))).toEqual({
          url: "https://example.com/hook",
        });
      },
      {
        responder: () => jsonResponse(WEBHOOK_ENDPOINT_CREATED),
        activeOrgId: "org_1",
      },
    );
  });

  it("creates one subscription per --event when provided as a comma list", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "webhook",
          "create",
          "https://example.com/hook",
          "--event=project.created,project.archived",
        ]);
        expect(r.exitCode).toBe(0);
        // 1 endpoint + 2 subscriptions.
        expect(cap.fetchCalls).toHaveLength(3);
        expect(cap.fetchCalls[1]!.url).toBe(
          "https://api.test/v1/organizations/org_1/webhooks/subscriptions",
        );
        expect(JSON.parse(String(cap.fetchCalls[1]!.init.body))).toEqual({
          endpointId: "whe_new",
          eventType: "project.created",
        });
        expect(JSON.parse(String(cap.fetchCalls[2]!.init.body))).toEqual({
          endpointId: "whe_new",
          eventType: "project.archived",
        });
      },
      {
        responder: ({ url }) =>
          url.endsWith("/subscriptions")
            ? jsonResponse(WEBHOOK_SUBSCRIPTION_CREATED)
            : jsonResponse(WEBHOOK_ENDPOINT_CREATED),
        activeOrgId: "org_1",
      },
    );
  });

  it("suffixes per-subscription idempotency keys (root:sub:N)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "webhook",
          "create",
          "https://example.com/hook",
          "--event=a,b",
          "--idempotency-key=root",
        ]);
        expect(r.exitCode).toBe(0);
        expect(pickHeader(cap.fetchCalls[0]!.init, "idempotency-key")).toBe("root");
        expect(pickHeader(cap.fetchCalls[1]!.init, "idempotency-key")).toBe(
          "root:sub:0",
        );
        expect(pickHeader(cap.fetchCalls[2]!.init, "idempotency-key")).toBe(
          "root:sub:1",
        );
      },
      {
        responder: ({ url }) =>
          url.endsWith("/subscriptions")
            ? jsonResponse(WEBHOOK_SUBSCRIPTION_CREATED)
            : jsonResponse(WEBHOOK_ENDPOINT_CREATED),
        activeOrgId: "org_1",
      },
    );
  });

  it("creates the endpoint only when no --event is given", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "webhook",
          "create",
          "https://example.com/hook",
        ]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls).toHaveLength(1);
        expect(cap.stdout.join("\n")).toContain("(none");
      },
      {
        responder: () => jsonResponse(WEBHOOK_ENDPOINT_CREATED),
        activeOrgId: "org_1",
      },
    );
  });

  it("missing url → usage exit 2", async () => {
    await withHarness(
      async ({ runArgv }) => {
        const r = await runArgv(["webhook", "create"]);
        expect(r.exitCode).toBe(2);
      },
      {
        responder: () => jsonResponse(WEBHOOK_ENDPOINT_CREATED),
        activeOrgId: "org_1",
      },
    );
  });
});

// ---- usage summary --------------------------------------------------------

describe("commands — usage summary", () => {
  it("hits /v1/organizations/:orgId/usage/summary with default metric=requests", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["usage", "summary"]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls[0]!.url).toBe(
          "https://api.test/v1/organizations/org_1/usage/summary?metric=requests",
        );
      },
      { responder: () => jsonResponse(USAGE_SUMMARY), activeOrgId: "org_1" },
    );
  });

  it("forwards --metric, --from, --to as query params", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "usage",
          "summary",
          "--metric=storage_gb",
          "--from=2025-01-01T00:00:00Z",
          "--to=2025-02-01T00:00:00Z",
        ]);
        expect(r.exitCode).toBe(0);
        const url = cap.fetchCalls[0]!.url;
        expect(url).toContain("metric=storage_gb");
        expect(url).toContain("startTime=2025-01-01T00%3A00%3A00Z");
        expect(url).toContain("endTime=2025-02-01T00%3A00%3A00Z");
      },
      { responder: () => jsonResponse(USAGE_SUMMARY), activeOrgId: "org_1" },
    );
  });

  it("missing org context → exit 5", async () => {
    await withHarness(
      async ({ runArgv }) => {
        const r = await runArgv(["usage", "summary"]);
        expect(r.exitCode).toBe(5);
      },
      { responder: () => jsonResponse(USAGE_SUMMARY) },
    );
  });

  it("--output=json round-trips the SDK shape", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["usage", "summary", "--output=json"]);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(cap.stdout[0] ?? "")).toEqual(USAGE_SUMMARY.data);
      },
      { responder: () => jsonResponse(USAGE_SUMMARY), activeOrgId: "org_1" },
    );
  });
});

// ---- billing summary ------------------------------------------------------

describe("commands — billing summary", () => {
  it("hits /v1/organizations/:orgId/billing/summary", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["billing", "summary"]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls[0]!.url).toBe(
          "https://api.test/v1/organizations/org_1/billing/summary",
        );
        const text = cap.stdout.join("\n");
        expect(text).toContain("Pro");
        expect(text).toContain("plan_pro");
      },
      { responder: () => jsonResponse(BILLING_SUMMARY), activeOrgId: "org_1" },
    );
  });

  it("missing org context → exit 5", async () => {
    await withHarness(
      async ({ runArgv }) => {
        const r = await runArgv(["billing", "summary"]);
        expect(r.exitCode).toBe(5);
      },
      { responder: () => jsonResponse(BILLING_SUMMARY) },
    );
  });

  it("--output=json round-trips the full SDK shape", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["billing", "summary", "--output=json"]);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(cap.stdout[0] ?? "")).toEqual(BILLING_SUMMARY.data);
      },
      { responder: () => jsonResponse(BILLING_SUMMARY), activeOrgId: "org_1" },
    );
  });
});

// ---- audit list -----------------------------------------------------------

describe("commands — audit list", () => {
  it("returns the first page and surfaces next_cursor", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["audit", "list", "--output=json"]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls[0]!.url).toBe(
          "https://api.test/v1/organizations/org_1/audit",
        );
        const parsed = JSON.parse(cap.stdout[0] ?? "");
        expect(parsed.next_cursor).toBe("cur_2");
        expect(parsed.auditEntries).toHaveLength(1);
      },
      { responder: () => jsonResponse(AUDIT_PAGE_1), activeOrgId: "org_1" },
    );
  });

  it("--limit and --category are forwarded as query params", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "audit",
          "list",
          "--limit=25",
          "--category=membership",
        ]);
        expect(r.exitCode).toBe(0);
        const url = cap.fetchCalls[0]!.url;
        expect(url).toContain("limit=25");
        expect(url).toContain("category=membership");
      },
      { responder: () => jsonResponse(AUDIT_PAGE_1), activeOrgId: "org_1" },
    );
  });

  it("--limit must be a positive integer (usage exit 2)", async () => {
    await withHarness(
      async ({ runArgv }) => {
        const r = await runArgv(["audit", "list", "--limit=notanumber"]);
        expect(r.exitCode).toBe(2);
      },
      { responder: () => jsonResponse(AUDIT_PAGE_1), activeOrgId: "org_1" },
    );
  });

  it("--all walks pages until cursor is null", async () => {
    let n = 0;
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["audit", "list", "--all", "--output=json"]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls).toHaveLength(2);
        expect(cap.fetchCalls[1]!.url).toContain("cursor=cur_2");
        // JSON Lines: one document per page.
        expect(cap.stdout).toHaveLength(2);
        expect(JSON.parse(cap.stdout[0] ?? "").next_cursor).toBe("cur_2");
        expect(JSON.parse(cap.stdout[1] ?? "").next_cursor).toBeNull();
      },
      {
        responder: () => {
          n += 1;
          return jsonResponse(n === 1 ? AUDIT_PAGE_1 : AUDIT_PAGE_2);
        },
        activeOrgId: "org_1",
      },
    );
  });

  it("--all + --cursor is a usage error (exit 2)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["audit", "list", "--all", "--cursor=foo"]);
        expect(r.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/mutually exclusive/);
      },
      { responder: () => jsonResponse(AUDIT_PAGE_1), activeOrgId: "org_1" },
    );
  });

  it("missing org context → exit 5", async () => {
    await withHarness(
      async ({ runArgv }) => {
        const r = await runArgv(["audit", "list"]);
        expect(r.exitCode).toBe(5);
      },
      { responder: () => jsonResponse(AUDIT_PAGE_1) },
    );
  });

  it("sends the bearer token on the audit request", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["audit", "list"]);
        expect(r.exitCode).toBe(0);
        expect(pickHeader(cap.fetchCalls[0]!.init, "authorization")).toBe(
          "Bearer tok",
        );
      },
      { responder: () => jsonResponse(AUDIT_PAGE_1), activeOrgId: "org_1" },
    );
  });

  it("human mode renders a table with audit columns", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["audit", "list"]);
        expect(r.exitCode).toBe(0);
        const text = cap.stdout.join("\n");
        expect(text).toMatch(/occurredAt\s+category\s+eventType\s+actor\s+id/);
        expect(text).toContain("ae_1");
        expect(text).toContain("user:usr_a");
      },
      { responder: () => jsonResponse(AUDIT_PAGE_1), activeOrgId: "org_1" },
    );
  });

  it("forwards all filter flags as query params", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "audit",
          "list",
          "--actor=usr_a",
          "--actor-type=user",
          "--subject-kind=project",
          "--subject-id=prj_1",
          "--event-type=member.role_changed",
          "--from=2026-01-01T00:00:00.000Z",
          "--to=2026-02-01T00:00:00.000Z",
        ]);
        expect(r.exitCode).toBe(0);
        const url = cap.fetchCalls[0]!.url;
        expect(url).toContain("actorId=usr_a");
        expect(url).toContain("actorType=user");
        expect(url).toContain("subjectKind=project");
        expect(url).toContain("subjectId=prj_1");
        expect(url).toContain("eventType=member.role_changed");
        expect(url).toContain("from=2026-01-01T00%3A00%3A00.000Z");
        expect(url).toContain("to=2026-02-01T00%3A00%3A00.000Z");
      },
      { responder: () => jsonResponse(AUDIT_PAGE_1), activeOrgId: "org_1" },
    );
  });

  it("--format=ndjson streams one JSON document per entry across all pages", async () => {
    let n = 0;
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["audit", "list", "--format=ndjson"]);
        expect(r.exitCode).toBe(0);
        // Both pages walked.
        expect(cap.fetchCalls).toHaveLength(2);
        expect(cap.fetchCalls[1]!.url).toContain("cursor=cur_2");
        // One stdout line per entry (AUDIT_PAGE_1 + AUDIT_PAGE_2 entries).
        expect(cap.stdout).toHaveLength(2);
        for (const line of cap.stdout) {
          const parsed = JSON.parse(line);
          expect(typeof parsed.id).toBe("string");
        }
        expect(JSON.parse(cap.stdout[0] ?? "").id).toBe("ae_1");
      },
      {
        responder: () => {
          n += 1;
          return jsonResponse(n === 1 ? AUDIT_PAGE_1 : AUDIT_PAGE_2);
        },
        activeOrgId: "org_1",
      },
    );
  });

  it("--format=ndjson forwards filters into the export stream", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "audit",
          "list",
          "--format=ndjson",
          "--actor-type=service_principal",
        ]);
        expect(r.exitCode).toBe(0);
        expect(cap.fetchCalls[0]!.url).toContain("actorType=service_principal");
      },
      { responder: () => jsonResponse(AUDIT_PAGE_2), activeOrgId: "org_1" },
    );
  });

  it("--format=ndjson + --cursor is a usage error (exit 2)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["audit", "list", "--format=ndjson", "--cursor=foo"]);
        expect(r.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/mutually exclusive/);
      },
      { responder: () => jsonResponse(AUDIT_PAGE_1), activeOrgId: "org_1" },
    );
  });

  it("--format with an unsupported value is a usage error (exit 2)", async () => {
    await withHarness(
      async ({ runArgv }) => {
        const r = await runArgv(["audit", "list", "--format=csv"]);
        expect(r.exitCode).toBe(2);
      },
      { responder: () => jsonResponse(AUDIT_PAGE_1), activeOrgId: "org_1" },
    );
  });
});
