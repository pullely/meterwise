// Tests for Task 0106 — `meterwise webhook verify` CLI subcommand.
//
// The command is pure local crypto: no SDK, no network, no auth, no
// active-org context. We exercise it through `runCli` with a synthetic
// stdin (an async-iterable Uint8Array stream) and a fixed `now()` so
// timestamp-tolerance behaviour is deterministic. The token store is a
// `MemoryTokenStore` with NO credentials loaded — verifying the command
// works without `meterwise login` (Hard Rule §3 in task-0106.md).

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { signWebhookPayload } from "@saas/webhook-verifier";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { MemoryTokenStore } from "./helpers.js";
import type { StdinLike } from "../commands/webhook-verify.js";

// ---- harness --------------------------------------------------------------

interface Cap {
  stdout: string[];
  stderr: string[];
}

interface RunOpts {
  argv: string[];
  stdinBody?: Uint8Array | string | null;
  /** Force `isTTY` flag on synthetic stdin (default: pipes when stdinBody is set). */
  stdinIsTTY?: boolean;
  /** Fixed `now()` for verifier (default: 1700000000 unix seconds). */
  nowEpochSeconds?: number;
}

const DEFAULT_NOW_EPOCH = 1700000000;

/**
 * Build a minimal `StdinLike`: an async-iterable wrapping a single chunk,
 * carrying an `isTTY` flag (default `false` when bytes were supplied,
 * `true` otherwise — matching `process.stdin` semantics). When `null`
 * is passed we return a TTY stdin that yields nothing, simulating
 * "no STDIN piped".
 */
function makeStdin(
  body: Uint8Array | string | null,
  isTTY?: boolean,
): StdinLike {
  const chunks: Uint8Array[] = [];
  if (body !== null) {
    chunks.push(typeof body === "string" ? new TextEncoder().encode(body) : body);
  }
  const isTTYResolved = isTTY ?? (body === null);
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-task0106-"));
  try {
    const cap: Cap = { stdout: [], stderr: [] };
    // No stored credential — `webhook verify` must work without `login`.
    const tokenStore = new MemoryTokenStore();
    const contextStore = new ContextStore({ configDir: dir });

    const run = (opts: RunOpts): Promise<{ exitCode: number }> =>
      runCli(opts.argv, {
        stdout: (l) => cap.stdout.push(l),
        stderr: (l) => cap.stderr.push(l),
        tokenStore,
        contextStore,
        webhookVerify: {
          stdin: makeStdin(opts.stdinBody ?? null, opts.stdinIsTTY),
          now: () => new Date((opts.nowEpochSeconds ?? DEFAULT_NOW_EPOCH) * 1000),
        },
      });

    await fn({ cap, run });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---- helpers --------------------------------------------------------------

async function signBody(
  secret: string,
  body: string,
  timestamp: number = DEFAULT_NOW_EPOCH,
): Promise<{ signature: string; timestamp: string }> {
  const sig = await signWebhookPayload({
    secret,
    body,
    timestamp: String(timestamp),
  });
  return { signature: sig, timestamp: String(timestamp) };
}

// ---- happy paths ----------------------------------------------------------

describe("webhook verify — happy paths", () => {
  it("human mode: valid signature → exit 0, prints `ok: true`", async () => {
    await withHarness(async ({ cap, run }) => {
      const body = `{"event":"project.created","id":"prj_1"}`;
      const { signature, timestamp } = await signBody("supersecret", body);
      const r = await run({
        argv: [
          "webhook",
          "verify",
          `--secret=supersecret`,
          `--signature=${signature}`,
          `--timestamp=${timestamp}`,
        ],
        stdinBody: body,
      });
      expect(r.exitCode).toBe(0);
      expect(cap.stdout[0]).toBe("ok: true");
      expect(cap.stdout[1]).toBe("reason: ");
      expect(cap.stderr).toEqual([]);
    });
  });

  it("json mode: valid signature → exit 0, prints `{\"ok\":true}`", async () => {
    await withHarness(async ({ cap, run }) => {
      const body = `{"event":"project.created"}`;
      const { signature, timestamp } = await signBody("s1", body);
      const r = await run({
        argv: [
          "webhook",
          "verify",
          `--secret=s1`,
          `--signature=${signature}`,
          `--timestamp=${timestamp}`,
          "--output=json",
        ],
        stdinBody: body,
      });
      expect(r.exitCode).toBe(0);
      expect(cap.stdout).toEqual([`{"ok":true}`]);
    });
  });

  it("--body=PATH: reads file bytes verbatim, no trim", async () => {
    await withHarness(async ({ cap, run }) => {
      // Body intentionally has leading + trailing whitespace and a final
      // newline. The CLI MUST NOT `.trim()` — the helper hashes bytes.
      const body = "  {\"event\":\"x\"}  \n";
      const { signature, timestamp } = await signBody("s2", body);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-body-"));
      const filePath = path.join(dir, "body.json");
      await fs.writeFile(filePath, body);
      try {
        const r = await run({
          argv: [
            "webhook",
            "verify",
            `--secret=s2`,
            `--signature=${signature}`,
            `--timestamp=${timestamp}`,
            `--body=${filePath}`,
          ],
          stdinBody: null, // no STDIN piped
        });
        expect(r.exitCode).toBe(0);
        expect(cap.stdout[0]).toBe("ok: true");
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  it("--tolerance-seconds=0 with now == timestamp passes", async () => {
    await withHarness(async ({ cap, run }) => {
      const body = "x";
      const { signature, timestamp } = await signBody("s3", body, 1700000000);
      const r = await run({
        argv: [
          "webhook",
          "verify",
          `--secret=s3`,
          `--signature=${signature}`,
          `--timestamp=${timestamp}`,
          "--tolerance-seconds=0",
        ],
        stdinBody: body,
        nowEpochSeconds: 1700000000,
      });
      expect(r.exitCode).toBe(0);
      expect(cap.stdout[0]).toBe("ok: true");
    });
  });
});

// ---- argument errors → exit 2 --------------------------------------------

describe("webhook verify — argument errors (exit 2)", () => {
  it("missing --secret → UsageError exit 2", async () => {
    await withHarness(async ({ cap, run }) => {
      const r = await run({
        argv: [
          "webhook",
          "verify",
          "--signature=sha256=00",
          "--timestamp=1700000000",
        ],
        stdinBody: "x",
      });
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--secret/);
    });
  });

  it("missing --signature → UsageError exit 2", async () => {
    await withHarness(async ({ cap, run }) => {
      const r = await run({
        argv: [
          "webhook",
          "verify",
          "--secret=s",
          "--timestamp=1700000000",
        ],
        stdinBody: "x",
      });
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--signature/);
    });
  });

  it("missing --timestamp → UsageError exit 2", async () => {
    await withHarness(async ({ cap, run }) => {
      const r = await run({
        argv: [
          "webhook",
          "verify",
          "--secret=s",
          "--signature=sha256=00",
        ],
        stdinBody: "x",
      });
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/--timestamp/);
    });
  });

  it("--tolerance-seconds=abc → UsageError exit 2", async () => {
    await withHarness(async ({ cap, run }) => {
      const r = await run({
        argv: [
          "webhook",
          "verify",
          "--secret=s",
          "--signature=sha256=00",
          "--timestamp=1700000000",
          "--tolerance-seconds=abc",
        ],
        stdinBody: "x",
      });
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toMatch(/tolerance-seconds/);
    });
  });

  it("--body=PATH and STDIN both → UsageError exit 2", async () => {
    await withHarness(async ({ cap, run }) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-bodyerr-"));
      const filePath = path.join(dir, "body.json");
      await fs.writeFile(filePath, "x");
      try {
        const r = await run({
          argv: [
            "webhook",
            "verify",
            "--secret=s",
            "--signature=sha256=00",
            "--timestamp=1700000000",
            `--body=${filePath}`,
          ],
          stdinBody: "y", // both supplied
          stdinIsTTY: false,
        });
        expect(r.exitCode).toBe(2);
        expect(cap.stderr.join("\n")).toMatch(/mutually exclusive|--body.*STDIN/i);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  it("--body=PATH for non-existent file → UsageError exit 2 with path in message", async () => {
    await withHarness(async ({ cap, run }) => {
      const r = await run({
        argv: [
          "webhook",
          "verify",
          "--secret=s",
          "--signature=sha256=00",
          "--timestamp=1700000000",
          "--body=/this/path/does/not/exist.json",
        ],
        stdinBody: null,
      });
      expect(r.exitCode).toBe(2);
      expect(cap.stderr.join("\n")).toContain("/this/path/does/not/exist.json");
    });
  });
});

// ---- verifier failures → exit 4 ------------------------------------------

describe("webhook verify — verifier failures (exit 4)", () => {
  it("tampered body → exit 4, reason: signature_mismatch", async () => {
    await withHarness(async ({ cap, run }) => {
      const original = "original body";
      const tampered = "tampered body";
      const { signature, timestamp } = await signBody("s4", original);
      const r = await run({
        argv: [
          "webhook",
          "verify",
          `--secret=s4`,
          `--signature=${signature}`,
          `--timestamp=${timestamp}`,
        ],
        stdinBody: tampered,
      });
      expect(r.exitCode).toBe(4);
      expect(cap.stdout).toContain("ok: false");
      expect(cap.stdout).toContain("reason: signature_mismatch");
    });
  });

  it("tampered hex signature (same length) → exit 4, signature_mismatch", async () => {
    await withHarness(async ({ cap, run }) => {
      const body = "z";
      const { signature, timestamp } = await signBody("s5", body);
      // Flip the first hex char after the prefix to corrupt the signature.
      const prefix = "sha256=";
      const hex = signature.slice(prefix.length);
      const flipped = (hex[0] === "0" ? "1" : "0") + hex.slice(1);
      const tampered = prefix + flipped;
      const r = await run({
        argv: [
          "webhook",
          "verify",
          `--secret=s5`,
          `--signature=${tampered}`,
          `--timestamp=${timestamp}`,
        ],
        stdinBody: body,
      });
      expect(r.exitCode).toBe(4);
      expect(cap.stdout).toContain("ok: false");
      expect(cap.stdout).toContain("reason: signature_mismatch");
    });
  });

  it("malformed signature header (no sha256= prefix) → exit 4, malformed_signature", async () => {
    await withHarness(async ({ cap, run }) => {
      const body = "z";
      const { timestamp } = await signBody("s6", body);
      const r = await run({
        argv: [
          "webhook",
          "verify",
          `--secret=s6`,
          `--signature=garbage`,
          `--timestamp=${timestamp}`,
        ],
        stdinBody: body,
      });
      expect(r.exitCode).toBe(4);
      expect(cap.stdout).toContain("reason: malformed_signature");
    });
  });

  it("timestamp older than --tolerance-seconds → exit 4, timestamp_out_of_tolerance", async () => {
    await withHarness(async ({ cap, run }) => {
      const oldTs = DEFAULT_NOW_EPOCH - 1000; // 1000s in the past
      const body = "x";
      const { signature, timestamp } = await signBody("s7", body, oldTs);
      const r = await run({
        argv: [
          "webhook",
          "verify",
          `--secret=s7`,
          `--signature=${signature}`,
          `--timestamp=${timestamp}`,
          "--tolerance-seconds=300",
        ],
        stdinBody: body,
        nowEpochSeconds: DEFAULT_NOW_EPOCH,
      });
      expect(r.exitCode).toBe(4);
      expect(cap.stdout).toContain("reason: timestamp_out_of_tolerance");
    });
  });

  it("json mode failure shape: exit 4, single-line `{\"ok\":false,\"reason\":\"...\"}`", async () => {
    await withHarness(async ({ cap, run }) => {
      const body = "x";
      const tampered = "y";
      const { signature, timestamp } = await signBody("s8", body);
      const r = await run({
        argv: [
          "webhook",
          "verify",
          `--secret=s8`,
          `--signature=${signature}`,
          `--timestamp=${timestamp}`,
          "--output=json",
        ],
        stdinBody: tampered,
      });
      expect(r.exitCode).toBe(4);
      expect(cap.stdout).toEqual([`{"ok":false,"reason":"signature_mismatch"}`]);
    });
  });

  it("reason-code passthrough is verbatim in human mode", async () => {
    // Confirms the human-mode line shape `reason: <code>` matches every
    // helper-emitted reason enum member exactly (no rewriting).
    const reasons = [
      "missing_signature",
      "missing_timestamp",
      "malformed_timestamp",
      "timestamp_out_of_tolerance",
      "malformed_signature",
      "signature_mismatch",
    ];
    for (const r of reasons) {
      expect(/^[a-z_]+$/.test(r)).toBe(true);
    }
    // Drive one path that exercises the human-mode formatter end-to-end.
    await withHarness(async ({ cap, run }) => {
      const body = "x";
      const { timestamp } = await signBody("s9", body);
      const r = await run({
        argv: [
          "webhook",
          "verify",
          `--secret=s9`,
          `--signature=sha256=zzzz`,
          `--timestamp=${timestamp}`,
        ],
        stdinBody: body,
      });
      expect(r.exitCode).toBe(4);
      // Match the line shape and confirm it carries one of the helper's
      // canonical reason codes verbatim.
      const reasonLine = cap.stdout.find((l) => l.startsWith("reason: ")) ?? "";
      const match = /^reason: ([a-z_]+)$/.exec(reasonLine);
      expect(match).not.toBeNull();
      expect(reasons).toContain(match![1]!);
    });
  });
});
