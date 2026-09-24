// Tests for Task 0114 — `meterwise webhook enable` CLI subcommand.
//
// The harness injects a *fake SDK* via `sdkFactory` rather than going
// through the real `Meterwise` client + a captured-fetch — the
// command is a thin one-call adapter over `sdk.webhooks.enableEndpoint`,
// so direct SDK-layer injection lets us assert the call shape (orgId,
// endpointId, body, options) without modelling the request envelope.
// The fake mirrors only the subset of the SDK the command touches.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  Meterwise,
  PublicWebhookEndpoint,
  EnableWebhookEndpointResponse,
} from "@saas/sdk";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { MemoryTokenStore } from "./helpers.js";

// ---- fixtures -------------------------------------------------------------

const FIXTURE_ENDPOINT: PublicWebhookEndpoint = {
  id: "wh_abc",
  orgId: "org_1",
  projectId: null,
  url: "https://example.com/hook",
  name: null,
  description: null,
  status: "active",
  disabledReason: null,
  disabledAt: null,
  secretVersion: 7,
  secretLastRotatedAt: "2025-06-01T00:00:00Z",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-06-15T12:34:56Z",
};

const RESPONSE: EnableWebhookEndpointResponse = { endpoint: FIXTURE_ENDPOINT };

// ---- harness --------------------------------------------------------------

interface EnableCall {
  orgId: string;
  endpointId: string;
  body: unknown;
  opts: Record<string, unknown>;
}

interface Cap {
  stdout: string[];
  stderr: string[];
  enableCalls: EnableCall[];
}

interface HarnessOpts {
  /** Controls what the fake `sdk.webhooks.enableEndpoint` returns. */
  response?: EnableWebhookEndpointResponse;
  /** Force the enableEndpoint mock to reject. */
  rejectWith?: Error;
  /** Active org id to seed in the context store (default org_1). */
  activeOrgId?: string | null;
  /** Stored credential. Pass `null` to simulate logged-out state. */
  storedCred?: { apiUrl: string; token: string } | null;
}

async function withHarness(
  fn: (h: {
    cap: Cap;
    runArgv: (argv: string[]) => Promise<{ exitCode: number }>;
  }) => Promise<void>,
  opts: HarnessOpts = {},
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-task0114-"));
  try {
    const cap: Cap = { stdout: [], stderr: [], enableCalls: [] };

    const tokenStore =
      opts.storedCred === null
        ? new MemoryTokenStore()
        : new MemoryTokenStore(
            opts.storedCred ?? { apiUrl: "https://api.test", token: "tok" },
          );
    const contextStore = new ContextStore({ configDir: dir });
    const orgId =
      opts.activeOrgId === null ? undefined : (opts.activeOrgId ?? "org_1");
    if (orgId !== undefined) await contextStore.setActiveOrg(orgId);

    const enableEndpoint = vi.fn(
      async (
        orgArg: string,
        endpointArg: string,
        bodyArg: unknown = {},
        callOpts: Record<string, unknown> = {},
      ): Promise<EnableWebhookEndpointResponse> => {
        cap.enableCalls.push({
          orgId: orgArg,
          endpointId: endpointArg,
          body: bodyArg,
          opts: callOpts,
        });
        if (opts.rejectWith !== undefined) throw opts.rejectWith;
        return opts.response ?? RESPONSE;
      },
    );

    const fakeSdk = {
      webhooks: { enableEndpoint },
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

// ---- tests ----------------------------------------------------------------

describe("commands — webhook enable", () => {
  // 1. Happy path human mode.
  it("human mode → exit 0; header + status block; SDK called (orgId, endpointId, {}, {})", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "enable", "wh_abc"]);
      expect(r.exitCode).toBe(0);
      const out = cap.stdout.join("\n");
      expect(out).toContain("Webhook endpoint re-enabled: wh_abc in org_1");
      expect(out).toContain("status:           active");
      expect(out).toContain("secretVersion:    7");
      expect(out).toContain("updatedAt:        2025-06-15T12:34:56Z");
      expect(cap.enableCalls).toHaveLength(1);
      expect(cap.enableCalls[0]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        body: {},
        opts: {},
      });
    });
  });

  // 2. Happy path JSON mode.
  it("json mode → single-line JSON with endpoint key; SDK called as above", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "enable",
        "wh_abc",
        "--output=json",
      ]);
      expect(r.exitCode).toBe(0);
      expect(cap.stdout).toHaveLength(1);
      const parsed = JSON.parse(cap.stdout[0] ?? "");
      expect(parsed).toHaveProperty("endpoint");
      expect(parsed.endpoint).toHaveProperty("id", "wh_abc");
      expect(parsed.endpoint).toHaveProperty("status", "active");
      expect(cap.enableCalls[0]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        body: {},
        opts: {},
      });
    });
  });

  // 3. Idempotency-key passthrough (and no-key shape).
  it("--idempotency-key=key-123 forwarded verbatim; no flag → {}", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r1 = await runArgv([
        "webhook",
        "enable",
        "wh_abc",
        "--idempotency-key=key-123",
      ]);
      expect(r1.exitCode).toBe(0);
      expect(cap.enableCalls[0]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        body: {},
        opts: { idempotencyKey: "key-123" },
      });

      const r2 = await runArgv(["webhook", "enable", "wh_abc"]);
      expect(r2.exitCode).toBe(0);
      expect(cap.enableCalls[1]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        body: {},
        opts: {},
      });
    });
  });

  // 4. Missing positional <endpointId> → UsageError, exit 2.
  it("missing <endpointId> → usage exit 2; no SDK call", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "enable"]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/usage: meterwise webhook enable/);
      expect(cap.enableCalls).toHaveLength(0);
    });
  });

  // 5. --output=yaml (invalid) → UsageError, exit 2.
  it("--output=yaml → usage exit 2; no SDK call", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "enable",
        "wh_abc",
        "--output=yaml",
      ]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--output must be human or json/);
      expect(cap.enableCalls).toHaveLength(0);
    });
  });

  // 6. --output (boolean true / no value) → UsageError, exit 2.
  it("--output with no value → usage exit 2; no SDK call", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "enable", "wh_abc", "--output"]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--output requires human\|json/);
      expect(cap.enableCalls).toHaveLength(0);
    });
  });

  // 7. SDK rejection propagates non-zero; response not leaked into stderr.
  it("SDK rejection → non-zero exit; error path clean", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "enable", "wh_abc"]);
        expect(r.exitCode).not.toBe(0);
        // The SDK was reached (orgId resolved, one call made) before rejecting.
        expect(cap.enableCalls).toHaveLength(1);
        // No stray endpoint payload echoed onto stdout on the error branch.
        expect(cap.stdout.join("\n")).not.toContain("re-enabled");
      },
      { rejectWith: new Error("server exploded") },
    );
  });

  // 8. No active org context → propagates; no SDK call.
  it("no active org → non-zero exit; no SDK call made", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "enable", "wh_abc"]);
        expect(r.exitCode).not.toBe(0);
        expect(cap.stderr.join("\n")).toMatch(/no active organization/i);
        expect(cap.enableCalls).toHaveLength(0);
      },
      { activeOrgId: null },
    );
  });

  // 9 (extra). Help output advertises the enable subcommand.
  it("top-level help lists the webhook enable usage line", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["--help"]);
      expect(r.exitCode).toBe(0);
      expect(cap.stdout.join("\n")).toContain(
        "meterwise webhook enable <endpointId> [--idempotency-key=KEY] [--output=human|json]",
      );
    });
  });
});
