import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripJsoncComments(text) {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

// BF6: resource IDs are never committed — wrangler.jsonc is rendered from
// wrangler.template.jsonc, so this checks the rendered shape (valid 32-hex,
// stage and prod distinct), not literal account IDs.
const EXPECTED_D1 = {
  stage: { binding: "PLATFORM_DB" },
  prod: { binding: "PLATFORM_DB" },
};

// A D1 database id is a UUID; the offline wiring fixture uses the 32-hex form.
const D1_ID_PATTERN =
  /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const seenD1Ids = new Map();

const EXPECTED_KV = {
  stage: {
    binding: "IDEMPOTENCY_KV",
  },
  prod: {
    binding: "IDEMPOTENCY_KV",
  },
};

const KV_ID_PATTERN = /^[0-9a-f]{32}$/;
const KV_ID_SENTINELS = new Set([
  "0000000000000000000000000000000a",
  "0000000000000000000000000000000b",
]);

// Service-binding targets carry the worker prefix the whole fleet ships with
// (`<brand>-<worker>-<env>`). The brand is NOT hardcoded: it is read from this
// worker's own `name`, so a rebranded fork verifies its own names instead of
// the baseline's. (Hardcoding it here is exactly what made this check pass in
// the baseline and fail in every fork.)
const EXPECTED_SERVICE_BINDINGS = [
  { binding: "IDENTITY_WORKER", worker: "identity-worker" },
  { binding: "MEMBERSHIP_WORKER", worker: "membership-worker" },
  { binding: "PROJECTS_WORKER", worker: "projects-worker" },
];

const configPath = resolve(__dirname, "../wrangler.jsonc");
const raw = readFileSync(configPath, "utf-8");
const config = JSON.parse(stripJsoncComments(raw));

let failures = 0;

for (const [envName, expected] of Object.entries(EXPECTED_D1)) {
  const envBlock = config.env?.[envName];
  if (!envBlock) {
    console.error(`FAIL: environment "${envName}" not found in wrangler.jsonc`);
    failures++;
    continue;
  }

  const db = envBlock.d1_databases?.find((d) => d.binding === expected.binding);
  if (!db) {
    console.error(
      `FAIL: [${envName}] missing d1_databases binding "${expected.binding}"`
    );
    failures++;
    continue;
  }

  if (typeof db.database_id !== "string" || !D1_ID_PATTERN.test(db.database_id)) {
    console.error(
      `FAIL: [${envName}] binding "${expected.binding}" database_id "${db.database_id}" is not a D1 id`
    );
    failures++;
    continue;
  }

  seenD1Ids.set(envName, db.database_id);

  const envVar = envBlock.vars?.ENVIRONMENT;
  if (envVar !== envName) {
    console.error(
      `FAIL: [${envName}] ENVIRONMENT var mismatch: got "${envVar}", want "${envName}"`
    );
    failures++;
    continue;
  }

  console.log(`OK: [${envName}] PLATFORM_DB → ${db.database_id}`);
}

if (seenD1Ids.has("stage") && seenD1Ids.get("stage") === seenD1Ids.get("prod")) {
  console.error(
    `FAIL: stage and prod share the same D1 database id "${seenD1Ids.get("stage")}" — ` +
      `one environment is bound to the other's data`
  );
  failures++;
}

for (const [envName, expected] of Object.entries(EXPECTED_KV)) {
  const envBlock = config.env?.[envName];
  if (!envBlock) {
    console.error(`FAIL: environment "${envName}" not found in wrangler.jsonc`);
    failures++;
    continue;
  }

  const kv = envBlock.kv_namespaces?.find((k) => k.binding === expected.binding);
  if (!kv) {
    console.error(
      `FAIL: [${envName}] missing kv_namespaces binding "${expected.binding}"`
    );
    failures++;
    continue;
  }

  if (typeof kv.id !== "string" || !KV_ID_PATTERN.test(kv.id)) {
    console.error(
      `FAIL: [${envName}] kv binding "${expected.binding}" id "${kv.id}" does not match /^[0-9a-f]{32}$/`
    );
    failures++;
    continue;
  }

  if (KV_ID_SENTINELS.has(kv.id)) {
    console.error(
      `FAIL: [${envName}] kv binding "${expected.binding}" still uses sentinel id "${kv.id}" — replace with the real Cloudflare KV namespace id`
    );
    failures++;
    continue;
  }

  console.log(`OK: [${envName}] ${expected.binding} → ${kv.id}`);
}

// `name` is `<brand>-api-edge`; everything before the last "-api-edge" is the
// brand prefix the fleet shares.
const brandPrefix = String(config.name ?? "").replace(/api-edge$/, "");

for (const envName of ["stage", "prod"]) {
  const envBlock = config.env?.[envName];
  if (!envBlock) {
    console.error(`FAIL: environment "${envName}" not found in wrangler.jsonc`);
    failures++;
    continue;
  }

  for (const expected of EXPECTED_SERVICE_BINDINGS) {
    const want = `${brandPrefix}${expected.worker}-${envName}`;
    const svc = envBlock.services?.find((s) => s.binding === expected.binding);
    if (!svc) {
      console.error(
        `FAIL: [${envName}] missing service binding "${expected.binding}"`
      );
      failures++;
      continue;
    }
    if (svc.service !== want) {
      console.error(
        `FAIL: [${envName}] service binding "${expected.binding}" target mismatch: got "${svc.service}", want "${want}"`
      );
      failures++;
      continue;
    }
    console.log(`OK: [${envName}] ${expected.binding} → ${svc.service}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} binding verification failure(s)`);
  process.exit(1);
} else {
  console.log("\nAll binding verifications passed.");
}
