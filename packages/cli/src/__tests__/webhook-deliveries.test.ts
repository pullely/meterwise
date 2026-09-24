// Tests for Task 0120 — `meterwise webhook deliveries` CLI subcommand.
//
// The harness injects a *fake SDK* via `sdkFactory` rather than going through
// the real `Meterwise` client + a captured-fetch — the command is a thin
// adapter over `sdk.webhooks.listDeliveryAttemptsPage`, so direct SDK-layer
// injection lets us assert the call shape (orgId, endpointId, query) and the
// cursor-following loop without modelling the request envelope. The fake
// mirrors only the subset of the SDK the command touches.
//
// Cursor provenance note: the page method returns `{ deliveryAttempts,
// nextCursor }` where `nextCursor` is the opaque token the worker emits in
// `meta.cursor`. The command forwards it verbatim; these tests assert that
// round-trip (default-mode title cursor, --all loop following, JSON
// `next_cursor` field) and never construct or parse the token.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  Meterwise,
  PublicWebhookDeliveryAttempt,
  DeliveryAttemptsPage,
} from "@saas/sdk";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { MemoryTokenStore } from "./helpers.js";

// ---- fixtures -------------------------------------------------------------

function attempt(
  over: Partial<PublicWebhookDeliveryAttempt> = {},
): PublicWebhookDeliveryAttempt {
  return {
    id: "att_1",
    orgId: "org_1",
    endpointId: "wh_abc",
    subscriptionId: "sub_1",
    eventId: "evt_1",
    eventType: "user.created",
    status: "success",
    attemptNumber: 1,
    httpStatusCode: 200,
    failureReason: null,
    idempotencyKey: null,
    nextRetryAt: null,
    completedAt: "2026-01-16T10:00:00.000Z",
    createdAt: "2026-01-16T09:59:59.000Z",
    updatedAt: "2026-01-16T10:00:00.000Z",
    ...over,
  };
}

// ---- harness --------------------------------------------------------------

interface PageCall {
  orgId: string;
  endpointId: string;
  query: unknown;
}

interface Cap {
  stdout: string[];
  stderr: string[];
  pageCalls: PageCall[];
}

interface HarnessOpts {
  /**
   * Sequence of pages the fake `listDeliveryAttemptsPage` returns, one per
   * call. When the calls outrun the array, the last entry is reused — but a
   * well-formed test supplies a terminating page (`nextCursor: null`).
   */
  pages?: DeliveryAttemptsPage[];
  /** Force the page mock to reject. */
  rejectWith?: Error;
  /** Active org id to seed in the context store (default org_1). */
  activeOrgId?: string | null;
  /** Stored credential. Pass `null` to simulate logged-out state. */
  storedCred?: { apiUrl: string; token: string } | null;
}

const SINGLE_PAGE: DeliveryAttemptsPage = {
  deliveryAttempts: [attempt()],
  nextCursor: null,
};

async function withHarness(
  fn: (h: {
    cap: Cap;
    runArgv: (argv: string[]) => Promise<{ exitCode: number }>;
  }) => Promise<void>,
  opts: HarnessOpts = {},
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-task0120-"));
  try {
    const cap: Cap = { stdout: [], stderr: [], pageCalls: [] };

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

    const pages = opts.pages ?? [SINGLE_PAGE];
    let callIndex = 0;
    const listDeliveryAttemptsPage = vi.fn(
      async (
        orgArg: string,
        endpointArg: string,
        queryArg: unknown = {},
      ): Promise<DeliveryAttemptsPage> => {
        cap.pageCalls.push({
          orgId: orgArg,
          endpointId: endpointArg,
          query: queryArg,
        });
        if (opts.rejectWith !== undefined) throw opts.rejectWith;
        const page = pages[Math.min(callIndex, pages.length - 1)];
        callIndex += 1;
        return page ?? SINGLE_PAGE;
      },
    );

    const fakeSdk = {
      webhooks: { listDeliveryAttemptsPage },
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

describe("commands — webhook deliveries", () => {
  // 1. Happy path human mode; single page, no query flags.
  it("human mode → exit 0; table with the attempt; SDK called (orgId, endpointId, {})", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "deliveries", "wh_abc"]);
      expect(r.exitCode).toBe(0);
      const out = cap.stdout.join("\n");
      expect(out).toContain("Delivery attempts for wh_abc in org_1");
      expect(out).toContain("user.created");
      expect(out).toContain("success");
      expect(out).toContain("att_1");
      expect(cap.pageCalls).toHaveLength(1);
      expect(cap.pageCalls[0]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        query: {},
      });
    });
  });

  // 2. Happy path JSON mode → { deliveryAttempts, next_cursor }.
  it("json mode → single-line JSON with deliveryAttempts + next_cursor", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "deliveries",
        "wh_abc",
        "--output=json",
      ]);
      expect(r.exitCode).toBe(0);
      expect(cap.stdout).toHaveLength(1);
      const parsed = JSON.parse(cap.stdout[0] ?? "");
      expect(parsed).toHaveProperty("deliveryAttempts");
      expect(parsed.deliveryAttempts[0]).toHaveProperty("id", "att_1");
      expect(parsed).toHaveProperty("next_cursor", null);
    });
  });

  // 3. --limit forwarded into the query.
  it("--limit=10 → query { limit: 10 }", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "deliveries",
        "wh_abc",
        "--limit=10",
      ]);
      expect(r.exitCode).toBe(0);
      expect(cap.pageCalls[0]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        query: { limit: 10 },
      });
    });
  });

  // 4. --cursor forwarded verbatim (opaque, never parsed).
  it("--cursor=OPAQUE → query { cursor: OPAQUE } verbatim", async () => {
    const opaque = "eyJjcmVhdGVkQXQiOiIyMDI2In0=";
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "deliveries",
        "wh_abc",
        `--cursor=${opaque}`,
      ]);
      expect(r.exitCode).toBe(0);
      expect(cap.pageCalls[0]).toEqual({
        orgId: "org_1",
        endpointId: "wh_abc",
        query: { cursor: opaque },
      });
    });
  });

  // 5. Default mode surfaces the next cursor in the human title when present.
  it("non-null nextCursor → title advertises the next cursor", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "deliveries", "wh_abc"]);
        expect(r.exitCode).toBe(0);
        expect(cap.stdout.join("\n")).toContain("(next cursor: CUR_NEXT)");
      },
      {
        pages: [{ deliveryAttempts: [attempt()], nextCursor: "CUR_NEXT" }],
      },
    );
  });

  // 6. --all follows the server cursor across pages until null.
  it("--all → follows cursor across pages; second call carries the prior cursor", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "deliveries", "wh_abc", "--all"]);
        expect(r.exitCode).toBe(0);
        expect(cap.pageCalls).toHaveLength(2);
        // First page: no cursor. Second page: the server-issued CUR_NEXT.
        expect(cap.pageCalls[0]).toEqual({
          orgId: "org_1",
          endpointId: "wh_abc",
          query: {},
        });
        expect(cap.pageCalls[1]).toEqual({
          orgId: "org_1",
          endpointId: "wh_abc",
          query: { cursor: "CUR_NEXT" },
        });
        const out = cap.stdout.join("\n");
        expect(out).toContain("All delivery attempts for wh_abc in org_1");
        expect(out).toContain("att_a");
        expect(out).toContain("att_b");
      },
      {
        pages: [
          { deliveryAttempts: [attempt({ id: "att_a" })], nextCursor: "CUR_NEXT" },
          { deliveryAttempts: [attempt({ id: "att_b" })], nextCursor: null },
        ],
      },
    );
  });

  // 7. --all JSON mode emits one JSON document per page (JSON Lines).
  it("--all --output=json → one JSON doc per page", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "webhook",
          "deliveries",
          "wh_abc",
          "--all",
          "--output=json",
        ]);
        expect(r.exitCode).toBe(0);
        expect(cap.stdout).toHaveLength(2);
        const first = JSON.parse(cap.stdout[0] ?? "");
        const second = JSON.parse(cap.stdout[1] ?? "");
        expect(first).toHaveProperty("next_cursor", "CUR_NEXT");
        expect(second).toHaveProperty("next_cursor", null);
      },
      {
        pages: [
          { deliveryAttempts: [attempt({ id: "att_a" })], nextCursor: "CUR_NEXT" },
          { deliveryAttempts: [attempt({ id: "att_b" })], nextCursor: null },
        ],
      },
    );
  });

  // 8. --all together with --cursor → UsageError, exit 2; no SDK call.
  it("--all + --cursor → usage exit 2; no SDK call", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "deliveries",
        "wh_abc",
        "--all",
        "--cursor=X",
      ]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(
        /--all and --cursor are mutually exclusive/,
      );
      expect(cap.pageCalls).toHaveLength(0);
    });
  });

  // 9. --limit non-positive → UsageError, exit 2; no SDK call.
  it("--limit=0 → usage exit 2; no SDK call", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "deliveries", "wh_abc", "--limit=0"]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--limit must be a positive integer/);
      expect(cap.pageCalls).toHaveLength(0);
    });
  });

  // 10. Missing positional <endpointId> → UsageError, exit 2; no SDK call.
  it("missing <endpointId> → usage exit 2; no SDK call", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["webhook", "deliveries"]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(
        /usage: meterwise webhook deliveries/,
      );
      expect(cap.pageCalls).toHaveLength(0);
    });
  });

  // 11. --output=yaml (invalid) → UsageError, exit 2; no SDK call.
  it("--output=yaml → usage exit 2; no SDK call", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "webhook",
        "deliveries",
        "wh_abc",
        "--output=yaml",
      ]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--output must be human or json/);
      expect(cap.pageCalls).toHaveLength(0);
    });
  });

  // 12. SDK rejection propagates non-zero; reached the SDK once.
  it("SDK rejection → non-zero exit; error path clean", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "deliveries", "wh_abc"]);
        expect(r.exitCode).not.toBe(0);
        expect(cap.pageCalls).toHaveLength(1);
      },
      { rejectWith: new Error("server exploded") },
    );
  });

  // 13. No active org context → propagates; no SDK call.
  it("no active org → non-zero exit; no SDK call made", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["webhook", "deliveries", "wh_abc"]);
        expect(r.exitCode).not.toBe(0);
        expect(cap.stderr.join("\n")).toMatch(/no active organization/i);
        expect(cap.pageCalls).toHaveLength(0);
      },
      { activeOrgId: null },
    );
  });

  // 14. Help output advertises the deliveries subcommand.
  it("top-level help lists the webhook deliveries usage line", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["--help"]);
      expect(r.exitCode).toBe(0);
      expect(cap.stdout.join("\n")).toContain(
        "meterwise webhook deliveries <endpointId> [--limit=N] [--cursor=CURSOR] [--all] [--output=human|json]",
      );
    });
  });
});
