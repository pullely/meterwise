// Tests for Task 0115 — `meterwise webhook disable` CLI subcommand.
//
// The harness injects a *fake SDK* via `sdkFactory` rather than going
// through the real `Meterwise` client + a captured-fetch — the
// command is a thin one-call adapter over `sdk.webhooks.disableEndpoint`,
// so direct SDK-layer injection lets us assert the call shape (orgId,
// endpointId, body, options) without modelling the request envelope.
// The fake mirrors only the subset of the SDK the command touches.
//
// Unlike the enable test (Task 0114), `DisableWebhookEndpointResponse`
// IS re-exported from `@saas/sdk`'s package index, so we import it
// directly and avoid local shape reconstruction.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  Meterwise,
  PublicWebhookEndpoint,
  DisableWebhookEndpointResponse,
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
  status: "disabled",
  disabledReason: "ops cleanup",
  disabledAt: "2025-06-15T12:34:56Z",
  secretVersion: 7,
  secretLastRotatedAt: "2025-06-01T00:00:00Z",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-06-15T12:34:56Z",
};

const RESPONSE: DisableWebhookEndpointResponse = { endpoint: FIXTURE_ENDPOINT };

// ---- harness --------------------------------------------------------------

interface DisableCall {
  orgId: string;
  endpointId: string;
  body: unknown;
  opts: Record<string, unknown>;
}

interface Cap {
  stdout: string[];
  stderr: string[];
  disableCalls: DisableCall[];
}

interface HarnessOpts {
  /** Controls what the fake `sdk.webhooks.disableEndpoint` returns. */
  response?: DisableWebhookEndpointResponse;
  /** Force the disableEndpoint mock to reject. */
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-task0115-"));
  try {
    const cap: Cap = { stdout: [], stderr: [], disableCalls: [] };

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

    const disableEndpoint = vi.fn(
      async (
        orgArg: string,
        endpointArg: string,
        bodyArg: unknown = {},
        callOpts: Record<string, unknown> = {},
      ): Promise<DisableWebhookEndpointResponse> => {
        cap.disableCalls.push({
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
      webhooks: { disableEndpoint },
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

describe("commands — webhook disable", () => {
  // 1. Happy path human mode; default body `{}`.
  it("human mode → exit 0; header + 4-line status block; SDK called (orgId, endpointId, {}, {})", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "disable", "wh_abc"]);
      expect(r.exitCode).toBe(0);
      const out = cap.stdout.join("\n");
      expect(out).toContain("Webhook endpoint disabled: wh_abc in org_1");
      expect(out).toContain("status:           disabled");
      expect(out).toContain("disabledReason:   ops cleanup");
      expect(out).toContain("disabledAt:       2025-06-15T12:34:56Z");
      expect(out).toContain("updatedAt:        2025-06-15T12:34:56Z");
      expect(cap.disableCalls).toHaveLength(1);
      expect(cap.disableCalls[0]).toEqual({
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
        "disable",
        "wh_abc",
        "--output=json",
      ]);
      expect(r.exitCode).toBe(0);
      expect(cap.stdout).toHaveLength(1);
      const parsed = JSON.parse(cap.stdout[0] ?? "");
      expect(parsed).toHaveProperty("endpoint");
      expect(parsed.endpoint).toHaveProperty("id", "wh_abc");
      expect(parsed.endpoint).toHaveProperty("status", "disabled");
      expect(cap.disableCalls[0]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        body: {},
        opts: {},
      });
    });
  });

  // 3. --reason=TEXT forwarded into body verbatim.
  it("--reason=\"ops cleanup\" → body { reason: \"ops cleanup\" }", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "disable",
        "wh_abc",
        "--reason=ops cleanup",
      ]);
      expect(r.exitCode).toBe(0);
      expect(cap.disableCalls[0]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        body: { reason: "ops cleanup" },
        opts: {},
      });
    });
  });

  // 4. --idempotency-key passthrough.
  it("--idempotency-key=key-123 forwarded verbatim to opts", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "disable",
        "wh_abc",
        "--idempotency-key=key-123",
      ]);
      expect(r.exitCode).toBe(0);
      expect(cap.disableCalls[0]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        body: {},
        opts: { idempotencyKey: "key-123" },
      });
    });
  });

  // 5. Reason + idempotency key together.
  it("--reason + --idempotency-key together: both forwarded to respective args", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "disable",
        "wh_abc",
        "--reason=stale endpoint",
        "--idempotency-key=key-xyz",
      ]);
      expect(r.exitCode).toBe(0);
      expect(cap.disableCalls[0]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        body: { reason: "stale endpoint" },
        opts: { idempotencyKey: "key-xyz" },
      });
    });
  });

  // 6. Missing positional <endpointId> → UsageError, exit 2.
  it("missing <endpointId> → usage exit 2; no SDK call", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "disable"]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(
        /usage: meterwise webhook disable/,
      );
      expect(cap.disableCalls).toHaveLength(0);
    });
  });

  // 7. --output=yaml (invalid) → UsageError, exit 2.
  it("--output=yaml → usage exit 2; no SDK call", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "disable",
        "wh_abc",
        "--output=yaml",
      ]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--output must be human or json/);
      expect(cap.disableCalls).toHaveLength(0);
    });
  });

  // 8. Bare --reason (no value) → UsageError, exit 2.
  it("bare --reason (no value) → usage exit 2; no SDK call", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "disable", "wh_abc", "--reason"]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--reason requires a value/);
      expect(cap.disableCalls).toHaveLength(0);
    });
  });

  // 9. SDK rejection propagates non-zero; response not leaked into stderr.
  it("SDK rejection → non-zero exit; error path clean", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "disable", "wh_abc"]);
        expect(r.exitCode).not.toBe(0);
        // The SDK was reached (orgId resolved, one call made) before rejecting.
        expect(cap.disableCalls).toHaveLength(1);
        // No stray endpoint payload echoed onto stdout on the error branch.
        expect(cap.stdout.join("\n")).not.toContain("disabled:");
      },
      { rejectWith: new Error("server exploded") },
    );
  });

  // 10. No active org context → propagates; no SDK call.
  it("no active org → non-zero exit; no SDK call made", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "disable", "wh_abc"]);
        expect(r.exitCode).not.toBe(0);
        expect(cap.stderr.join("\n")).toMatch(/no active organization/i);
        expect(cap.disableCalls).toHaveLength(0);
      },
      { activeOrgId: null },
    );
  });

  // 11 (extra). Help output advertises the disable subcommand.
  it("top-level help lists the webhook disable usage line", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["--help"]);
      expect(r.exitCode).toBe(0);
      expect(cap.stdout.join("\n")).toContain(
        "meterwise webhook disable <endpointId> [--reason=TEXT] [--idempotency-key=KEY] [--output=human|json]",
      );
    });
  });
});
