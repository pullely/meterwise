#!/usr/bin/env node
// CLI binary entrypoint. Imports the runner from the package index and
// dispatches `process.argv`. Kept tiny so it stays trivially auditable.

import { runCli } from "./cli-runner.js";

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2));
  process.exit(result.exitCode);
}

main().catch((err: unknown) => {
  // Last-resort handler — `runCli` already maps known errors to exit codes
  // and prints them. Anything that escapes here is a programmer bug.
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`fatal: ${message}\n`);
  process.exit(1);
});
