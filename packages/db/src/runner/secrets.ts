// D1 credentials from the ENVIRONMENT.
//
// The `cloudflare-d1` terraform component publishes its outputs to the
// workspace's project/env secret rung (the composition's wire-secrets step),
// and orun resolves the keys this runner declares in its component `secretEnv`
// into the job env. Nothing is read from a file, a cloud secret store, or an
// ambient CI value.
//
// Two shapes are accepted for the database id, because the wiring layer speaks
// documents and an operator running this by hand speaks variables:
//   - WIRING_CLOUDFLARE_D1 — the component's JSON wiring document
//   - D1_DATABASE_ID       — the flat override

export interface D1Credentials {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set — declare it in the component's secretEnv ` +
        `(wired from the cloudflare-d1 component's outputs)`,
    );
  }
  return value;
}

/** Pull the database id out of the wiring document, if one is present. */
function databaseIdFromWiring(): string | null {
  const raw = process.env["WIRING_CLOUDFLARE_D1"]?.trim();
  if (!raw) return null;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("WIRING_CLOUDFLARE_D1 is set but is not valid JSON");
  }
  const id = doc["d1_database_id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function loadD1CredentialsFromEnv(): D1Credentials {
  const databaseId = process.env["D1_DATABASE_ID"]?.trim() || databaseIdFromWiring();
  if (!databaseId) {
    throw new Error(
      "No D1 database id — set D1_DATABASE_ID, or wire WIRING_CLOUDFLARE_D1 " +
        "from the cloudflare-d1 component",
    );
  }
  return {
    accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
    databaseId,
    apiToken: requireEnv("CLOUDFLARE_API_TOKEN"),
  };
}
