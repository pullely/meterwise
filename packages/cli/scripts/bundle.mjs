#!/usr/bin/env node
// Bundles the CLI directly from TypeScript sources. tsc is reserved for
// type-checking + .d.ts emit; the runtime artifact is produced by esbuild
// so the binary can be executed by Node without resolving sibling
// workspaces (`@saas/sdk` exports raw `.ts`, which Node ESM cannot load
// without a bundler).
//
// Inputs : src/cli.ts
// Output : dist/cli.js (executable, with shebang)
//
// `keytar` is marked external so it remains an optional dependency
// dynamically imported by `token-store/keychain.ts`.

import { build } from "esbuild";
import { chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const entry = resolve(pkgRoot, "src/cli.ts");
const out = resolve(pkgRoot, "dist/cli.js");

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: out,
  external: ["keytar"],
  // Source already has a shebang; do not re-emit one via banner.
  legalComments: "none",
  minify: false,
  sourcemap: false,
  logLevel: "warning",
});

chmodSync(out, 0o755);

