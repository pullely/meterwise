// Tests for Task 0122 — `meterwise security events` CLI subcommand.
//
// The harness injects a *fake SDK* via `sdkFactory` rather than going through
// the real `Meterwise` client + a captured-fetch — the command is a thin
// adapter over `sdk.securityEvents.listPage`, so direct SDK-layer injection
// lets us assert the call shape (query) and the cursor-following loop without
// modelling the request envelope. The fake mirrors only the subset of the SDK
// the command touches.
//
// Actor-scope note: this surface is account/actor-scoped, NOT org-scoped — the
// command takes no `<orgId>` positional and never calls `resolveOrgId`. The
// page method is therefore called with `(query)` only.
//
// Cursor provenance note: `listPage` returns `{ securityEvents, nextCursor }`
// where `nextCursor` is the opaque token the worker emits in `meta.cursor`.
// The command forwards it verbatim; these tests assert that round-trip
// (default-mode title cursor, --all loop following, JSON `next_cursor` field)
// and never construct or parse the token.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  Meterwise,
  PublicSecurityEvent,
  SecurityEventsPage,
} from "@saas/sdk";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { MemoryTokenStore } from "./helpers.js";

// ---- fixtures -------------------------------------------------------------

function event(over: Partial<PublicSecurityEvent> = {}): PublicSecurityEvent {
  return {
    id: "se_1",
    eventType: "session.created",
    outcome: "success",
    occurredAt: "2026-01-16T10:00:00.000Z",
    requestId: "req_1",
    correlationId: null,
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    metadata: {},
    ...over,
  };
}

// ---- harness --------------------------------------------------------------

interface PageCall {
  query: unknown;
}

interface Cap {
  stdout: string[];
  stderr: string[];
  pageCalls: PageCall[];
}

interface HarnessOpts {
  /**
   * Sequence of pages the fake `listPage` returns, one per call. When the
   * calls outrun the array, the last entry is reused — but a well-formed test
   * supplies a terminating page (`nextCursor: null`).
   */
  pages?: SecurityEventsPage[];
  /** Force the page mock to reject. */
  rejectWith?: Error;
  /** Stored credential. Pass `null` to simulate logged-out state. */
  storedCred?: { apiUrl: string; token: string } | null;
}

const SINGLE_PAGE: SecurityEventsPage = {
  securityEvents: [event()],
  nextCursor: null,
};

async function withHarness(
  fn: (h: {
    cap: Cap;
    runArgv: (argv: string[]) => Promise<{ exitCode: number }>;
  }) => Promise<void>,
  opts: HarnessOpts = {},
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-task0122-"));
  try {
    const cap: Cap = { stdout: [], stderr: [], pageCalls: [] };

    const tokenStore =
      opts.storedCred === null
        ? new MemoryTokenStore()
        : new MemoryTokenStore(
            opts.storedCred ?? { apiUrl: "https://api.test", token: "tok" },
          );
    const contextStore = new ContextStore({ configDir: dir });

    const pages = opts.pages ?? [SINGLE_PAGE];
    let callIndex = 0;
    const listPage = vi.fn(
      async (queryArg: unknown = {}): Promise<SecurityEventsPage> => {
        cap.pageCalls.push({ query: queryArg });
        if (opts.rejectWith !== undefined) throw opts.rejectWith;
        const page = pages[Math.min(callIndex, pages.length - 1)];
        callIndex += 1;
        return page ?? SINGLE_PAGE;
      },
    );

    const fakeSdk = {
      securityEvents: { listPage },
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

describe("commands — security events", () => {
  // 1. Happy path human mode; single page, no query flags.
  it("human mode → exit 0; table with the event; SDK called with {}", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["security", "events"]);
      expect(r.exitCode).toBe(0);
      const out = cap.stdout.join("\n");
      expect(out).toContain("Security events");
      expect(out).toContain("session.created");
      expect(out).toContain("success");
      expect(out).toContain("se_1");
      expect(cap.pageCalls).toHaveLength(1);
      expect(cap.pageCalls[0]).toEqual({ query: {} });
    });
  });

  // 2. Happy path JSON mode → { securityEvents, next_cursor }.
  it("json mode → single-line JSON with securityEvents + next_cursor", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["security", "events", "--output=json"]);
      expect(r.exitCode).toBe(0);
      expect(cap.stdout).toHaveLength(1);
      const parsed = JSON.parse(cap.stdout[0] ?? "");
      expect(parsed).toHaveProperty("securityEvents");
      expect(parsed.securityEvents[0]).toHaveProperty("id", "se_1");
      expect(parsed).toHaveProperty("next_cursor", null);
    });
  });

  // 3. --limit forwarded into the query.
  it("--limit=10 → query { limit: 10 }", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["security", "events", "--limit=10"]);
      expect(r.exitCode).toBe(0);
      expect(cap.pageCalls[0]).toEqual({ query: { limit: 10 } });
    });
  });

  // 4. --cursor forwarded verbatim (opaque, never parsed).
  it("--cursor=OPAQUE → query { cursor: OPAQUE } verbatim", async () => {
    const opaque = "eyJjcm...2In0=";
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["security", "events", `--cursor=${opaque}`]);
      expect(r.exitCode).toBe(0);
      expect(cap.pageCalls[0]).toEqual({ query: { cursor: opaque } });
    });
  });

  // 5. Default mode surfaces the next cursor in the human title when present.
  it("non-null nextCursor → title advertises the next cursor", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["security", "events"]);
        expect(r.exitCode).toBe(0);
        expect(cap.stdout.join("\n")).toContain("(next cursor: CUR_NEXT)");
      },
      {
        pages: [{ securityEvents: [event()], nextCursor: "CUR_NEXT" }],
      },
    );
  });

  // 6. --all follows the server cursor across pages until null.
  it("--all → follows cursor across pages; second call carries the prior cursor", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["security", "events", "--all"]);
        expect(r.exitCode).toBe(0);
        expect(cap.pageCalls).toHaveLength(2);
        // First page: no cursor. Second page: the server-issued CUR_NEXT.
        expect(cap.pageCalls[0]).toEqual({ query: {} });
        expect(cap.pageCalls[1]).toEqual({ query: { cursor: "CUR_NEXT" } });
        const out = cap.stdout.join("\n");
        expect(out).toContain("All security events");
        expect(out).toContain("se_a");
        expect(out).toContain("se_b");
      },
      {
        pages: [
          { securityEvents: [event({ id: "se_a" })], nextCursor: "CUR_NEXT" },
          { securityEvents: [event({ id: "se_b" })], nextCursor: null },
        ],
      },
    );
  });

  // 7. --all JSON mode emits one JSON document per page (JSON Lines).
  it("--all --output=json → one JSON doc per page", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv([
          "security",
          "events",
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
          { securityEvents: [event({ id: "se_a" })], nextCursor: "CUR_NEXT" },
          { securityEvents: [event({ id: "se_b" })], nextCursor: null },
        ],
      },
    );
  });

  // 8. --all + --cursor → UsageError, exit 2; no SDK call.
  it("--all + --cursor → usage exit 2; no SDK call", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv([
        "security",
        "events",
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
      const r = await runArgv(["security", "events", "--limit=0"]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--limit must be a positive integer/);
      expect(cap.pageCalls).toHaveLength(0);
    });
  });

  // 10. --output=yaml (invalid) → UsageError, exit 2; no SDK call.
  it("--output=yaml → usage exit 2; no SDK call", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["security", "events", "--output=yaml"]);
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--output must be human or json/);
      expect(cap.pageCalls).toHaveLength(0);
    });
  });

  // 11. SDK rejection propagates non-zero; reached the SDK once.
  it("SDK rejection → non-zero exit; error path clean", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["security", "events"]);
        expect(r.exitCode).not.toBe(0);
        expect(cap.pageCalls).toHaveLength(1);
      },
      { rejectWith: new Error("server exploded") },
    );
  });

  // 12. Logged-out state → non-zero exit; no SDK call.
  it("no stored credential → non-zero exit; no SDK call made", async () => {
    await withHarness(
      async ({ cap, runArgv }) => {
        const r = await runArgv(["security", "events"]);
        expect(r.exitCode).not.toBe(0);
        expect(cap.pageCalls).toHaveLength(0);
      },
      { storedCred: null },
    );
  });

  // 13. Help output advertises the security events subcommand.
  it("top-level help lists the security events usage line", async () => {
    await withHarness(async ({ cap, runArgv }) => {
      const r = await runArgv(["--help"]);
      expect(r.exitCode).toBe(0);
      expect(cap.stdout.join("\n")).toContain(
        "meterwise security events [--limit=N] [--cursor=CURSOR] [--all] [--output=human|json]",
      );
    });
  });
});
