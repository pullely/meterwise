// Tests for Task 0107 — `meterwise webhook sign` CLI subcommand.
//
// Symmetric to webhook-verify.test.ts (Task 0106). The command is pure
// local crypto: no SDK, no network, no auth. We exercise it through
// `runCli` with a synthetic stdin and a `MemoryTokenStore` carrying NO
// credentials, proving the command is usable on a fresh install with
// no `meterwise login`.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { signWebhookPayload, verifyWebhookSignature } from "@saas/webhook-verifier";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { MemoryTokenStore } from "./helpers.js";
import type { StdinLike } from "../commands/webhook-sign.js";

// ---- harness --------------------------------------------------------------

interface Cap {
  stdout: string[];
  stderr: string[];
}

interface RunOpts {
  argv: string[];
  stdinBody?: Uint8Array | string | null;
  stdinIsTTY?: boolean;
}

function makeStdin(
  body: Uint8Array | string | null,
  isTTY?: boolean,
): StdinLike {
  const chunks: Uint8Array[] = [];
  if (body !== null) {
    chunks.push(typeof body === "string" ? new TextEncoder().encode(body) : body);
  }
  const isTTYResolved = isTTY ?? body === null;
  return Object.assign(
    {
      async *[Symbol.asyncIterator]() {
        for (const c of chunks) yield c;
      },
    },
    { isTTY: isTTYResolved },
  ) as StdinLike;
}

async function withHarness(
  fn: (h: {
    cap: Cap;
    run: (opts: RunOpts) => Promise<{ exitCode: number }>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-task0107-"));
  try {
    const cap: Cap = { stdout: [], stderr: [] };
    const tokenStore = new MemoryTokenStore();
    const contextStore = new ContextStore({ configDir: dir });

    const run = (opts: RunOpts): Promise<{ exitCode: number }> =>
      runCli(opts.argv, {
        stdout: (l) => cap.stdout.push(l),
        stderr: (l) => cap.stderr.push(l),
        tokenStore,
        contextStore,
        webhookSign: {
          stdin: makeStdin(opts.stdinBody ?? null, opts.stdinIsTTY),
        },
      });

    await fn({ cap, run });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---- happy paths ----------------------------------------------------------

describe("webhook sign — happy paths", () => {
  it("human mode: STDIN body + valid timestamp → exit 0, prints sig+ts", async () => {
    await withHarness(async ({ cap, run }) => {
      const body = `{"event":"project.created","id":"prj_1"}`;
      const r = await run({
        argv: [
          "webhook",
          "sign",
          "--secret=supersecret",
          "--timestamp=1700000000",
        ],
        stdinBody: body,
      });
      expect(r.exitCode).toBe(0);
      expect(cap.stderr).toEqual([]);
      expect(cap.stdout.length).toBe(2);
      // Single render = two `stdout()` lines; the runner appends \n
      // between them when joined for the regex assertion the task
      // requires.
      const rendered = `${cap.stdout.join("\n")}\n`;
      expect(rendered).toMatch(/^signature: sha256=[0-9a-f]{64}\ntimestamp: \d+\n$/);
      expect(cap.stdout[1]).toBe("timestamp: 1700000000");
    });
  });

  it("json mode: single-line valid JSON with signature + timestamp", async () => {
    await withHarness(async ({ cap, run }) => {
      const body = `{"event":"project.created"}`;
      const r = await run({
        argv: [
          "webhook",
          "sign",
          "--secret=s1",
          "--timestamp=1700000000",
          "--output=json",
        ],
        stdinBody: body,
      });
      expect(r.exitCode).toBe(0);
      expect(cap.stdout.length).toBe(1);
      const parsed = JSON.parse(cap.stdout[0] as string) as {
        signature: string;
        timestamp: string;
      };
      expect(typeof parsed.signature).toBe("string");
      expect(parsed.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(parsed.timestamp).toBe("1700000000");
    });
  });

  it("--body=PATH reads file bytes binary-safe (no trim)", async () => {
    await withHarness(async ({ cap, run }) => {
      // Body intentionally has leading + trailing whitespace and a final
      // newline. The CLI MUST NOT `.trim()`.
      const body = "  {\"event\":\"x\"}  \n";
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-sign-body-"));
      const filePath = path.join(dir, "body.json");
      await fs.writeFile(filePath, body);
      try {
        const r = await run({
          argv: [
            "webhook",
            "sign",
            "--secret=s2",
            "--timestamp=1700000000",
            `--body=${filePath}`,
          ],
          stdinBody: null, // no STDIN piped (TTY)
        });
        expect(r.exitCode).toBe(0);
        // Helper-computed expected signature for the *exact* bytes.
        const expected = await signWebhookPayload({
          secret: "s2",
          body,
          timestamp: "1700000000",
        });
        expect(cap.stdout[0]).toBe(`signature: ${expected}`);
        expect(cap.stdout[1]).toBe("timestamp: 1700000000");
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });
});

// ---- argument errors → exit 2 --------------------------------------------

describe("webhook sign — argument errors (exit 2)", () => {
  it("--body=PATH and STDIN both → UsageError exit 2", async () => {
    await withHarness(async ({ cap, run }) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-sign-bodyerr-"));
      const filePath = path.join(dir, "body.json");
      await fs.writeFile(filePath, "x");
      try {
        const r = await run({
          argv: [
            "webhook",
            "sign",
            "--secret=s",
            "--timestamp=1700000000",
            `--body=${filePath}`,
          ],
          stdinBody: "y",
          stdinIsTTY: false,
        });
        expect(r.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/mutually exclusive|--body.*STDIN/i);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  it("missing body (no flag, no STDIN) → UsageError exit 2", async () => {
    await withHarness(async ({ cap, run }) => {
      const r = await run({
        argv: [
          "webhook",
          "sign",
          "--secret=s",
          "--timestamp=1700000000",
        ],
        stdinBody: null, // TTY → no STDIN piped, no --body flag
      });
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--body=PATH or pipe/i);
    });
  });

  it("missing --secret → UsageError exit 2", async () => {
    await withHarness(async ({ cap, run }) => {
      const r = await run({
        argv: ["webhook", "sign", "--timestamp=1700000000"],
        stdinBody: "x",
      });
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--secret/);
    });
  });

  it("missing --timestamp → UsageError exit 2", async () => {
    await withHarness(async ({ cap, run }) => {
      const r = await run({
        argv: ["webhook", "sign", "--secret=s"],
        stdinBody: "x",
      });
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--timestamp/);
    });
  });

  it("--timestamp=abc (non-integer) → UsageError exit 2", async () => {
    await withHarness(async ({ cap, run }) => {
      const r = await run({
        argv: [
          "webhook",
          "sign",
          "--secret=s",
          "--timestamp=abc",
        ],
        stdinBody: "x",
      });
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--timestamp/);
    });
  });

  it("--timestamp=-5 (negative) → UsageError exit 2", async () => {
    await withHarness(async ({ cap, run }) => {
      const r = await run({
        argv: [
          "webhook",
          "sign",
          "--secret=s",
          "--timestamp=-5",
        ],
        stdinBody: "x",
      });
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--timestamp/);
    });
  });

  it("--output=invalid → UsageError exit 2", async () => {
    await withHarness(async ({ cap, run }) => {
      const r = await run({
        argv: [
          "webhook",
          "sign",
          "--secret=s",
          "--timestamp=1700000000",
          "--output=yaml",
        ],
        stdinBody: "x",
      });
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--output/);
    });
  });
});

// ---- multi-byte + round-trip ---------------------------------------------

describe("webhook sign — multi-byte + round-trip", () => {
  it("multi-byte UTF-8 body bytes signed with deterministic helper-equivalent value", async () => {
    await withHarness(async ({ cap, run }) => {
      // Compose body via Buffer.from to guarantee byte exactness.
      const bodyBytes = Buffer.from("héllo 漢字", "utf8");
      const r = await run({
        argv: [
          "webhook",
          "sign",
          "--secret=supersecret",
          "--timestamp=1700000000",
        ],
        stdinBody: new Uint8Array(bodyBytes),
      });
      expect(r.exitCode).toBe(0);
      // Precomputed value: HMAC-SHA256("supersecret", "1700000000.héllo 漢字")
      // (verified against the helper itself in this very test by also
      // calling signWebhookPayload, so the value is locked to the
      // helper's contract — independent of any node:crypto re-impl).
      const expected = await signWebhookPayload({
        secret: "supersecret",
        body: bodyBytes.toString("utf8"),
        timestamp: "1700000000",
      });
      expect(expected).toBe(
        "sha256=3ad5be6cb96bdadf9d83c4c5e5fd567b88c5bc94d568933365a68b9b3ce526b5",
      );
      expect(cap.stdout[0]).toBe(`signature: ${expected}`);
    });
  });

  it("round-trip: sign output verifies against verifyWebhookSignature directly", async () => {
    await withHarness(async ({ cap, run }) => {
      const body = `{"event":"webhook.delivered","attempt":3}`;
      const secret = "round-trip-secret";
      const timestamp = "1700000000";
      const r = await run({
        argv: [
          "webhook",
          "sign",
          `--secret=${secret}`,
          `--timestamp=${timestamp}`,
          "--output=json",
        ],
        stdinBody: body,
      });
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(cap.stdout[0] as string) as {
        signature: string;
        timestamp: string;
      };
      // Verify directly via the helper (NOT through the CLI).
      const result = await verifyWebhookSignature({
        secret,
        body,
        headers: {
          "X-Webhook-Signature": parsed.signature,
          "X-Webhook-Timestamp": parsed.timestamp,
        },
        now: () => new Date(Number(timestamp) * 1000),
      });
      expect(result).toEqual({ ok: true });
    });
  });
});
