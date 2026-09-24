#!/usr/bin/env node
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "../manifest.js";
import { runMigrations } from "./runner.js";
import { loadD1CredentialsFromEnv } from "./secrets.js";
import { D1ApiAdapter } from "./d1-api-adapter.js";
import type { MigrationAdapter, RunMode } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

function usage(): never {
  process.stderr.write(
    `Usage: db-migrate <plan|apply> --env <stage|prod>\n` +
    `\n` +
    `Modes:\n` +
    `  plan   — report pending migrations without mutating the database\n` +
    `  apply  — apply pending migrations against the environment's D1 database\n` +
    `\n` +
    `Options:\n` +
    `  --env <stage|prod>       target environment (required)\n` +
    `\n` +
    `Environment (apply mode; all wired from orun secrets):\n` +
    `  CLOUDFLARE_ACCOUNT_ID    Cloudflare account owning the D1 database\n` +
    `  CLOUDFLARE_API_TOKEN     account token with D1 edit permission\n` +
    `  WIRING_CLOUDFLARE_D1     wiring document from the cloudflare-d1 component\n` +
    `                           (or D1_DATABASE_ID to name the database directly)\n`,
  );
  process.exit(1);
}

interface ParsedArgs {
  mode: RunMode;
  env: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  const mode = args[0] as RunMode | undefined;
  if (mode !== "plan" && mode !== "apply") {
    usage();
  }

  let env: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]) {
      env = args[++i];
    }
  }

  if (!env) {
    const envFromEnv = process.env["MIGRATION_ENV"];
    if (envFromEnv) {
      env = envFromEnv;
    }
  }

  if (!env || !["stage", "prod"].includes(env)) {
    process.stderr.write("Error: --env must be 'stage' or 'prod'\n");
    process.exit(1);
  }

  return { mode, env };
}

// The environment is not a parameter here: orun resolves each environment's
// secrets into the job env, so the D1 database this run targets is whichever
// one the lane was given. `--env` names the lane for the log and the output.
async function resolveAdapter(mode: RunMode): Promise<MigrationAdapter | null> {
  if (mode === "plan") {
    return null;
  }

  process.stderr.write(`Loading credentials from the wired environment (orun secrets)\n`);
  const credentials = loadD1CredentialsFromEnv();

  return new D1ApiAdapter(credentials.accountId, credentials.databaseId, credentials.apiToken);
}

async function main(): Promise<void> {
  const { mode, env } = parseArgs(process.argv);

  process.stderr.write(`db-migrate: mode=${mode} env=${env}\n`);

  const adapter = await resolveAdapter(mode);

  const result = await runMigrations(manifest, {
    mode,
    migrationsDir: MIGRATIONS_DIR,
    adapter,
  });

  if (result.failed) {
    process.stderr.write(
      `FAILED: migration ${result.failed.id} — ${result.failed.error}\n`,
    );
    process.exit(1);
  }

  const output = {
    mode,
    env,
    applied: result.applied,
    skipped: result.skipped,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`db-migrate: fatal error — ${message}\n`);
  process.exit(1);
});
