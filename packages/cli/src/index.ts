// Public package index for `@saas/cli`.
//
// The package's primary deliverable is the `meterwise` binary
// (`./dist/cli.js`). This index is exported only so tests can load the
// package via `import` without going through the binary entrypoint, and so
// that downstream tooling can re-use the command-handler types if it needs
// to.
//
// Loadability constraint (PR Boundary §2): this module must NOT pull in
// `keytar` at import time. The keychain adapter inside `token-store/` is
// dynamic-import-only; importing this index in a non-Node host (Workers,
// Bun, browser) must not throw on missing native bindings.

export { runCli } from "./cli-runner.js";
export type { CommandContext, CommandHandler, CommandResult } from "./router.js";
export { Router } from "./router.js";
export { formatOutput, type OutputMode } from "./output/index.js";
export { CLI_VERSION } from "./version.js";
