// Tests for Task 0126 — `meterwise webhook deliveries replay` CLI subcommand.
//
// Mirrors the Task 0120 `webhook deliveries` harness: a *fake SDK* is injected
// via `sdkFactory` so we assert the call shape (orgId, attemptId) and the
// rendered output without modelling the request envelope. The command is a thin
// one-call adapter over `sdk.webhooks.replayDelivery`.
//
// Router note: `webhook deliveries replay` is a longer registered path than
// `webhook deliveries`, so the longest-prefix resolver routes the three-token
// argv to the replay command (the first positional `<attemptId>` is NOT
// swallowed as the `deliveries` endpointId).

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  Meterwise,
  PublicWebhookDeliveryAttempt,
  ReplayWebhookDeliveryResponse,
} from "@saas/sdk";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { MemoryTokenStore } from "./helpers.js";

// ---- fixtures -------------------------------------------------------------

function attempt(
  over: Partial<PublicWebhookDeliveryAttempt> = {},
): PublicWebhookDeliveryAttempt {
  return {
    id: "whd_new",
    orgId: "org_1",
    endpointId: "whe_abc",
    subscriptionId: "whs_1",
    eventId: "evt_1",
    eventType: "user.created",
    status: "success",
    attemptNumber: 1,
    httpStatusCode: 200,
    failureReason: null,
    idempotencyKey: "whs_1:evt_1:replay:whd_new",
    nextRetryAt: null,
    completedAt: "2026-02-01T10:00:00.000Z",
    createdAt: "2026-02-01T09:59:59.000Z",
    updatedAt: "2026-02-01T10:00:00.000Z",
    ...over,
  };
}

// ---- harness --------------------------------------------------------------

interface ReplayCall {
  orgId: string;
  attemptId: string;
}

interface Cap {
  stdout: string[];
  stderr: string[];
  replayCalls: ReplayCall[];
}

interface HarnessOpts {
  response?: ReplayWebhookDeliveryResponse;
  rejectWith?: Error;
  activeOrgId?: string | null;
  storedCred?: { apiUrl: string; token: string } | null;
}

async function withHarness(
  fn: (h: {
    cap: Cap;
    runArgv: (argv: string[]) => Promise<{ exitCode: number }>;
  }) => Promise<void>,
  opts: HarnessOpts = {},
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-task0126-"));
  try {
    const cap: Cap = { stdout: [], stderr: [], replayCalls: [] };

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

    const response: ReplayWebhookDeliveryResponse = opts.response ?? {
      deliveryAttempt: attempt(),
    };
    const replayDelivery = vi.fn(
      async (
        orgArg: string,
        attemptArg: string,
      ): Promise<ReplayWebhookDeliveryResponse> => {
        cap.replayCalls.push({ orgId: orgArg, attemptId: attemptArg });
        if (opts.rejectWith !== undefined) throw opts.rejectWith;
        return response;
      },
    );

    const fakeSdk = {
      webhooks: { replayDelivery },
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

describe("commands — webhook deliveries replay", () => {
  // 1. Happy path human mode — routes to replay, prints the new attempt row.
  it("replays an attempt and renders the new attempt in human mode", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "deliveries", "replay", "whd_old"]);
      expect(r.exitCode).toBe(0);
      expect(cap.replayCalls).toEqual([{ orgId: "org_1", attemptId: "whd_old" }]);
      const out = cap.stdout.join("\n");
      expect(out).toContain("whd_new");
      expect(out).toContain("success");
    });
  });

  // 2. JSON mode emits the raw { deliveryAttempt } object.
  it("emits the deliveryAttempt object in JSON mode", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "deliveries",
        "replay",
        "whd_old",
        "--output=json",
      ]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(cap.stdout.join("\n"));
      expect(parsed.deliveryAttempt.id).toBe("whd_new");
      expect(parsed.deliveryAttempt.attemptNumber).toBe(1);
    });
  });

  // 3. Missing positional <attemptId> → UsageError (exit 2), no SDK call.
  it("errors with usage when attemptId is missing", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "deliveries", "replay"]);
      expect(r.exitCode).toBe(2);
      expect(cap.replayCalls).toHaveLength(0);
      expect(cap.stderr.join("\n")).toMatch(
        /usage: meterwise webhook deliveries replay/,
      );
    });
  });

  // 4. Invalid --output → UsageError (exit 2), no SDK call.
  it("rejects an invalid --output value", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "deliveries",
        "replay",
        "whd_old",
        "--output=yaml",
      ]);
      expect(r.exitCode).toBe(2);
      expect(cap.replayCalls).toHaveLength(0);
    });
  });

  // 5. SDK error (e.g. 404) is propagated as a non-zero exit.
  it("propagates an SDK error as a non-zero exit", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "deliveries", "replay", "whd_x"]);
        expect(r.exitCode).not.toBe(0);
        expect(cap.replayCalls).toHaveLength(1);
      },
      { rejectWith: new Error("not_found") },
    );
  });

  // 6. A failed-status replay still renders (terminal failed outcome).
  it("renders a failed replay outcome", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "deliveries", "replay", "whd_old"]);
        expect(r.exitCode).toBe(0);
        expect(cap.stdout.join("\n")).toContain("failed");
      },
      {
        response: {
          deliveryAttempt: attempt({
            status: "failed",
            httpStatusCode: 500,
            failureReason: "http_500",
          }),
        },
      },
    );
  });

  // 7. Help output advertises the replay subcommand.
  it("top-level help lists the webhook deliveries replay usage line", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      await runArgv(["--help"]);
      expect(cap.stdout.join("\n")).toContain(
        "meterwise webhook deliveries replay <attemptId> [--idempotency-key=KEY] [--output=human|json]",
      );
    });
  });
});
