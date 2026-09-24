// Tests for Task 0110 — `meterwise webhook secrets rotate` CLI subcommand.
//
// The harness injects a *fake SDK* via `sdkFactory` rather than going
// through the real `Meterwise` client + a captured-fetch — the
// command is a thin one-call adapter over `sdk.webhooks.rotateSecret`,
// so direct SDK-layer injection lets us assert the call shape (orgId,
// endpointId, options) without modelling the request envelope. The
// fake mirrors only the subset of the SDK the command touches.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Meterwise, RotateWebhookSecretResponse } from "@saas/sdk";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { MemoryTokenStore } from "./helpers.js";

// ---- fixtures -------------------------------------------------------------

const FIXTURE_ENDPOINT = {
  id: "wh_abc",
  orgId: "org_1",
  projectId: null,
  url: "https://example.com/hook",
  name: null,
  description: null,
  status: "active" as const,
  disabledReason: null,
  disabledAt: null,
  secretVersion: 7,
  secretLastRotatedAt: "2025-06-01T00:00:00Z",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-06-01T00:00:00Z",
};

// 32 hex chars after `whsec_`, matching the contract surface.
const FIXTURE_SECRET_PLAINTEXT = "whsec_0123456789abcdef0123456789abcdef";

const RESPONSE_WITH_SECRET: RotateWebhookSecretResponse = {
  endpoint: FIXTURE_ENDPOINT,
  secret: FIXTURE_SECRET_PLAINTEXT,
  previousSecretExpiresAt: "2025-06-02T00:00:00Z",
  gracePeriodSeconds: 86400,
};

const RESPONSE_WITHOUT_SECRET: RotateWebhookSecretResponse = {
  endpoint: FIXTURE_ENDPOINT,
  previousSecretExpiresAt: "2025-06-02T00:00:00Z",
  gracePeriodSeconds: 86400,
};

// ---- harness --------------------------------------------------------------

interface RotateCall {
  orgId: string;
  endpointId: string;
  opts: Record<string, unknown>;
}

interface Cap {
  stdout: string[];
  stderr: string[];
  rotateCalls: RotateCall[];
}

interface HarnessOpts {
  /** Controls what the fake `sdk.webhooks.rotateSecret` returns. */
  response?: RotateWebhookSecretResponse;
  /** Force the rotateSecret mock to reject. */
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-task0110-"));
  try {
    const cap: Cap = { stdout: [], stderr: [], rotateCalls: [] };

    const tokenStore =
      opts.storedCred === null
        ? new MemoryTokenStore()
        : new MemoryTokenStore(
            opts.storedCred ?? { apiUrl: "https://api.test", token: "tok" },
          );
    const contextStore = new ContextStore({ configDir: dir });
    const orgId =
      opts.activeOrgId === null
        ? undefined
        : (opts.activeOrgId ?? "org_1");
    if (orgId !== undefined) await contextStore.setActiveOrg(orgId);

    const rotateSecret = vi.fn(
      async (
        orgArg: string,
        endpointArg: string,
        callOpts: Record<string, unknown> = {},
      ): Promise<RotateWebhookSecretResponse> => {
        cap.rotateCalls.push({
          orgId: orgArg,
          endpointId: endpointArg,
          opts: callOpts,
        });
        if (opts.rejectWith !== undefined) throw opts.rejectWith;
        return opts.response ?? RESPONSE_WITH_SECRET;
      },
    );

    const fakeSdk = {
      webhooks: { rotateSecret },
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

describe("commands — webhook secrets rotate", () => {
  // 1. Happy path human mode, secret present.
  it("human mode with secret → exit 0; header + reveal-once warning + literal whsec_<32hex>", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "secrets", "rotate", "wh_abc"]);
      expect(r.exitCode).toBe(0);
      const out = cap.stdout.join("\n");
      expect(out).toContain("Webhook signing secret rotated for wh_abc in org_1");
      expect(out).toContain(FIXTURE_SECRET_PLAINTEXT);
      expect(out).toContain("This secret will not be shown again");
      expect(out).toContain("X-Webhook-Signature-Previous");
      expect(out).toContain("secretVersion:    7");
      expect(out).toContain("gracePeriod:      86400s");
    });
  });

  // 2. Happy path JSON mode, secret present.
  it("json mode with secret → single-line JSON with all four contract keys", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "secrets",
        "rotate",
        "wh_abc",
        "--output=json",
      ]);
      expect(r.exitCode).toBe(0);
      expect(cap.stdout).toHaveLength(1);
      const parsed = JSON.parse(cap.stdout[0] ?? "");
      expect(parsed).toHaveProperty("endpoint");
      expect(parsed).toHaveProperty("secret", FIXTURE_SECRET_PLAINTEXT);
      expect(parsed).toHaveProperty(
        "previousSecretExpiresAt",
        "2025-06-02T00:00:00Z",
      );
      expect(parsed).toHaveProperty("gracePeriodSeconds", 86400);
    });
  });

  // 3. Legacy no-key path human mode (no `secret` field).
  it("human mode without secret → no-key warning, no whsec_ in stdout", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "secrets", "rotate", "wh_abc"]);
        expect(r.exitCode).toBe(0);
        const out = cap.stdout.join("\n");
        expect(out).toContain("Plaintext was not returned by the server");
        expect(out).not.toContain("whsec_");
      },
      { response: RESPONSE_WITHOUT_SECRET },
    );
  });

  // 4. Legacy no-key path JSON mode.
  it("json mode without secret → no `secret` key, no whsec_ in stdout", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "webhook",
          "secrets",
          "rotate",
          "wh_abc",
          "--output=json",
        ]);
        expect(r.exitCode).toBe(0);
        const parsed = JSON.parse(cap.stdout[0] ?? "");
        expect(
          Object.prototype.hasOwnProperty.call(parsed, "secret"),
        ).toBe(false);
        expect(cap.stdout.join("\n")).not.toContain("whsec_");
      },
      { response: RESPONSE_WITHOUT_SECRET },
    );
  });

  // 5. previousSecretExpiresAt: null renders as "(none)".
  it("human mode renders previousSecretExpiresAt: null as (none)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "secrets", "rotate", "wh_abc"]);
        expect(r.exitCode).toBe(0);
        expect(cap.stdout.join("\n")).toContain("previousExpires:  (none)");
      },
      {
        response: {
          ...RESPONSE_WITH_SECRET,
          previousSecretExpiresAt: null,
        },
      },
    );
  });

  // 6. previousSecretExpiresAt: ISO string renders verbatim.
  it("human mode renders previousSecretExpiresAt ISO verbatim", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "secrets", "rotate", "wh_abc"]);
        expect(r.exitCode).toBe(0);
        expect(cap.stdout.join("\n")).toContain(
          "previousExpires:  2099-12-31T23:59:59Z",
        );
      },
      {
        response: {
          ...RESPONSE_WITH_SECRET,
          previousSecretExpiresAt: "2099-12-31T23:59:59Z",
        },
      },
    );
  });

  // 7. gracePeriodSeconds: 0 renders as "0s" (not "(none)").
  it("human mode renders gracePeriodSeconds 0 as 0s (not collapsed)", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "secrets", "rotate", "wh_abc"]);
        expect(r.exitCode).toBe(0);
        const out = cap.stdout.join("\n");
        expect(out).toContain("gracePeriod:      0s");
        expect(out).not.toContain("gracePeriod:      (none)");
      },
      {
        response: {
          ...RESPONSE_WITH_SECRET,
          gracePeriodSeconds: 0,
        },
      },
    );
  });

  // 8. Missing positional <endpointId> → UsageError, exit 2.
  it("missing <endpointId> → usage exit 2", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "secrets", "rotate"]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/usage/);
      expect(cap.rotateCalls).toHaveLength(0);
    });
  });

  // 9. --output=invalid → UsageError, exit 2.
  it("--output=invalid → usage exit 2", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "secrets",
        "rotate",
        "wh_abc",
        "--output=yaml",
      ]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--output/);
      expect(cap.rotateCalls).toHaveLength(0);
    });
  });

  // 10. Idempotency-key passthrough (and no-key shape).
  it("--idempotency-key=foo passes { idempotencyKey: 'foo' }; no flag → {}", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r1 = await runArgv([
        "webhook",
        "secrets",
        "rotate",
        "wh_abc",
        "--idempotency-key=foo",
      ]);
      expect(r1.exitCode).toBe(0);
      expect(cap.rotateCalls[0]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        opts: { idempotencyKey: "foo" },
      });

      const r2 = await runArgv(["webhook", "secrets", "rotate", "wh_abc"]);
      expect(r2.exitCode).toBe(0);
      expect(cap.rotateCalls[1]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        opts: {},
      });
    });
  });

  // 11. SDK error propagates; no whsec_ in stderr/stdout.
  it("SDK rejection propagates non-zero exit; no whsec_ leaked", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "secrets", "rotate", "wh_abc"]);
        expect(r.exitCode).not.toBe(0);
        const all = cap.stdout.concat(cap.stderr).join("\n");
        expect(all).not.toContain("whsec_");
      },
      { rejectWith: new Error("server exploded") },
    );
  });

  // 12. Reveal-once stdout discipline — exactly one whsec_ in stdout.
  it("human mode prints whsec_ exactly once (reveal-once discipline)", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "secrets", "rotate", "wh_abc"]);
      expect(r.exitCode).toBe(0);
      const stdout = cap.stdout.join("\n");
      const matches = stdout.match(/whsec_/g);
      expect(matches?.length).toBe(1);
    });
  });

  // 13 (extra). Missing org context → exit 5.
  it("no active org → exit 5", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "secrets", "rotate", "wh_abc"]);
        expect(r.exitCode).toBe(5);
        expect(cap.stderr.join("\n")).toMatch(/no active organization/i);
        expect(cap.rotateCalls).toHaveLength(0);
      },
      { activeOrgId: null },
    );
  });
});
