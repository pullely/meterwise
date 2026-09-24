import { describe, expect, it } from "vitest";

import { runCli } from "../cli-runner.js";
import { ContextStore } from "../context/store.js";
import { CLI_VERSION } from "../version.js";
import { MemoryTokenStore } from "./helpers.js";

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

function harness(): {
  out: CapturedOutput;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
} {
  const out: CapturedOutput = { stdout: [], stderr: [] };
  return {
    out,
    stdout: (line) => out.stdout.push(line),
    stderr: (line) => out.stderr.push(line),
  };
}

describe("cli — argv routing", () => {
  it("`--help` exits 0 and prints USAGE", async () => {
    const { out, stdout, stderr } = harness();
    const result = await runCli(["--help"], {
      stdout,
      stderr,
      tokenStore: new MemoryTokenStore(),
      contextStore: new ContextStore({ configDir: "/tmp/cli-test-help" }),
    });
    expect(result.exitCode).toBe(0);
    expect(out.stdout.join("\n")).toContain("USAGE:");
    expect(out.stdout.join("\n")).toContain("meterwise org list");
  });

  it("no argv prints help and exits 0", async () => {
    const { out, stdout, stderr } = harness();
    const result = await runCli([], {
      stdout,
      stderr,
      tokenStore: new MemoryTokenStore(),
      contextStore: new ContextStore({ configDir: "/tmp/cli-test-noargs" }),
    });
    expect(result.exitCode).toBe(0);
    expect(out.stdout.join("\n")).toContain("meterwise v");
  });

  it("`--version` (human) prints the version", async () => {
    const { out, stdout, stderr } = harness();
    const result = await runCli(["--version"], {
      stdout,
      stderr,
      tokenStore: new MemoryTokenStore(),
      contextStore: new ContextStore({ configDir: "/tmp/cli-test-v" }),
    });
    expect(result.exitCode).toBe(0);
    expect(out.stdout).toEqual([CLI_VERSION]);
  });

  it("`--version --output=json` emits a JSON document", async () => {
    const { out, stdout, stderr } = harness();
    const result = await runCli(["--version", "--output=json"], {
      stdout,
      stderr,
      tokenStore: new MemoryTokenStore(),
      contextStore: new ContextStore({ configDir: "/tmp/cli-test-vj" }),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(out.stdout[0] ?? "")).toEqual({ version: CLI_VERSION });
  });

  it("unknown command exits non-zero with a usage error", async () => {
    const { out, stdout, stderr } = harness();
    const result = await runCli(["nope"], {
      stdout,
      stderr,
      tokenStore: new MemoryTokenStore(),
      contextStore: new ContextStore({ configDir: "/tmp/cli-test-unknown" }),
    });
    expect(result.exitCode).toBe(2);
    expect(out.stderr.join("\n")).toMatch(/unknown command/);
  });

  it("unknown command in JSON mode emits an error envelope", async () => {
    const { out, stdout, stderr } = harness();
    const result = await runCli(["nope", "--output=json"], {
      stdout,
      stderr,
      tokenStore: new MemoryTokenStore(),
      contextStore: new ContextStore({ configDir: "/tmp/cli-test-unknownj" }),
    });
    expect(result.exitCode).toBe(2);
    const parsed = JSON.parse(out.stderr[0] ?? "");
    expect(parsed).toEqual({
      error: { code: "usage", message: expect.stringContaining("unknown command") },
    });
  });
});
