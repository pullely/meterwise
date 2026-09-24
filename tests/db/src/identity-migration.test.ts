import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(
  __dirname,
  "../../..",
  "packages/db/src/migrations",
);

describe("Identity Migration Verification", () => {
  const identityMigrations = manifest.migrations.filter(
    (m) => m.context === "identity",
  );

  it("has at least one identity migration", () => {
    expect(identityMigrations.length).toBeGreaterThan(0);
  });

  it("identity migration has context 'identity'", () => {
    for (const m of identityMigrations) {
      expect(m.context).toBe("identity");
    }
  });

  it("identity migration is ordered after control migrations", () => {
    const ids = manifest.migrations.map((m) => m.id);
    const controlIdx = ids.indexOf("000_control_baseline");
    const identityIdx = ids.indexOf("010_identity_core");

    expect(identityIdx).toBeGreaterThan(controlIdx);
  });

  describe("identity SQL schema validation", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "010_identity_core/up.sql"),
      "utf-8",
    );

    it("namespaces its tables to the identity context", () => {
      // SQLite has no schemas — the context boundary is the name prefix.
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS identity_");
    });

    it("creates identity_users table", () => {
      expect(sql).toContain("identity_users");
    });

    it("creates identity_auth_identities table", () => {
      expect(sql).toContain("identity_auth_identities");
    });

    it("creates identity_login_challenges table", () => {
      expect(sql).toContain("identity_login_challenges");
    });

    it("creates identity_sessions table", () => {
      expect(sql).toContain("identity_sessions");
    });

    it("stores only hashed codes, never raw values", () => {
      expect(sql).toContain("code_hash");
      expect(sql).not.toMatch(/\bcode\b\s+TEXT/);
    });

    it("stores only hashed tokens, never raw values", () => {
      expect(sql).toContain("token_hash");
      expect(sql).not.toMatch(/\btoken\b\s+TEXT/);
    });

    it("uses normalized email column for lookup", () => {
      expect(sql).toContain("email_lower");
      expect(sql).toContain("users_email_lower_idx");
    });

    it("uses IF NOT EXISTS for idempotency", () => {
      const createStatements = sql.match(/CREATE\s+(TABLE|SCHEMA|INDEX)/g) ?? [];
      const ifNotExists = sql.match(/IF NOT EXISTS/g) ?? [];
      expect(ifNotExists.length).toBeGreaterThanOrEqual(createStatements.length);
    });

    it("does not reference cross-context tables", () => {
      expect(sql).not.toContain("membership.");
      expect(sql).not.toContain("projects.");
      expect(sql).not.toContain("billing.");
      expect(sql).not.toContain("events.");
    });

    it("does not require extensions like citext", () => {
      expect(sql).not.toContain("CREATE EXTENSION");
      expect(sql).not.toContain("citext");
    });

    it("foreign keys stay within identity context", () => {
      const fkMatches = sql.match(/REFERENCES\s+(\w+\.\w+)/g) ?? [];
      for (const fk of fkMatches) {
        expect(fk).toContain("identity.");
      }
    });
  });

  describe("project-scoped invariant still applies only to projects context", () => {
    it("identity migrations are not subject to project-scoped org_id/project_id check", () => {
      expect(identityMigrations.every((m) => m.context === "identity")).toBe(true);
      expect(identityMigrations.some((m) => m.context === "projects")).toBe(false);
    });
  });

  describe("050_identity_security_events SQL schema validation", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "050_identity_security_events/up.sql"),
      "utf-8",
    );

    it("creates identity_security_events table", () => {
      expect(sql).toContain("identity_security_events");
    });

    it("has all expected columns", () => {
      const expectedColumns = [
        "id", "event_type", "outcome", "user_id", "session_id",
        "challenge_id", "request_id", "correlation_id", "ip",
        "user_agent", "occurred_at", "created_at", "metadata", "redact_paths",
      ];
      for (const col of expectedColumns) {
        expect(sql).toContain(col);
      }
    });

    it("stores JSON metadata for flexible payloads", () => {
      expect(sql).toMatch(/metadata\s+TEXT/);
    });

    it("stores JSON redact_paths for compliance", () => {
      expect(sql).toMatch(/redact_paths\s+TEXT/);
    });

    it("does not store raw secret columns", () => {
      const secretPatterns = [
        /\bcode\b\s+TEXT/,
        /\btoken\b\s+TEXT/,
        /\bbearer_token\b/,
        /\btoken_hash\b/,
        /\bcode_hash\b/,
        /\bapi_key\b/,
        /\bsecret\b\s+TEXT/,
      ];
      for (const pattern of secretPatterns) {
        expect(sql).not.toMatch(pattern);
      }
    });

    it("does not require org_id", () => {
      expect(sql).not.toMatch(/org_id\s+\w+\s+NOT NULL/);
    });

    it("uses IF NOT EXISTS for idempotency", () => {
      const createStatements = sql.match(/CREATE\s+(TABLE|INDEX)/g) ?? [];
      const ifNotExists = sql.match(/IF NOT EXISTS/g) ?? [];
      expect(ifNotExists.length).toBeGreaterThanOrEqual(createStatements.length);
    });

    it("does not reference cross-context tables", () => {
      expect(sql).not.toContain("membership.");
      expect(sql).not.toContain("projects.");
      expect(sql).not.toContain("billing.");
      expect(sql).not.toContain("events.");
    });

    it("creates user+time index for cursor pagination", () => {
      expect(sql).toContain("security_events_user_occurred_idx");
      expect(sql).toMatch(/user_id.*occurred_at\s+DESC.*id\s+DESC/);
    });

    it("creates event type index", () => {
      expect(sql).toContain("security_events_event_type_idx");
    });

    it("creates request_id index for trace lookups", () => {
      expect(sql).toContain("security_events_request_id_idx");
    });

    it("uses a text primary key holding a UUID", () => {
      expect(sql).toMatch(/id\s+TEXT\s+PRIMARY KEY/);
    });

    it("foreign keys stay within identity context if any exist", () => {
      const fkMatches = sql.match(/REFERENCES\s+(\w+\.\w+)/g) ?? [];
      for (const fk of fkMatches) {
        expect(fk).toContain("identity.");
      }
    });
  });

  describe("060_identity_api_keys SQL schema validation", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "060_identity_api_keys/up.sql"),
      "utf-8",
    );

    it("creates identity_service_principals table", () => {
      expect(sql).toContain("identity_service_principals");
    });

    it("creates identity_api_keys table", () => {
      expect(sql).toContain("identity_api_keys");
    });

    it("service principals have org_id NOT NULL for organization binding", () => {
      expect(sql).toMatch(/org_id\s+TEXT\s+NOT NULL/);
    });

    it("service principals have optional project_id scope", () => {
      expect(sql).toMatch(/project_id\s+TEXT/);
      // project_id should NOT be NOT NULL
      expect(sql).not.toMatch(/project_id\s+TEXT\s+NOT NULL/);
    });

    it("enforces project scope requires org scope via CHECK constraint", () => {
      expect(sql).toContain("service_principals_project_scope_check");
    });

    it("API keys store only hash and prefix, never raw key material", () => {
      expect(sql).toContain("key_hash");
      expect(sql).toContain("key_prefix");
      // No raw key/secret/token columns
      expect(sql).not.toMatch(/\bkey_value\b/);
      expect(sql).not.toMatch(/\braw_key\b/);
      expect(sql).not.toMatch(/\bsecret\b\s+TEXT/);
      expect(sql).not.toMatch(/\bbearer_token\b/);
    });

    it("API keys have key_prefix length constraint (4-12 chars)", () => {
      expect(sql).toContain("api_keys_prefix_length");
    });

    it("API keys have unique hash index for auth-time lookup", () => {
      expect(sql).toContain("api_keys_key_hash_idx");
    });

    it("API keys belong to a service principal via FK", () => {
      expect(sql).toMatch(/REFERENCES\s+identity_service_principals/);
    });

    it("has org-scoped index for API key listing", () => {
      expect(sql).toContain("api_keys_org_id_idx");
    });

    it("has service principal index for key listing", () => {
      expect(sql).toContain("api_keys_service_principal_idx");
    });

    it("has prefix index for key identification", () => {
      expect(sql).toContain("api_keys_prefix_idx");
    });

    it("uses IF NOT EXISTS for idempotency", () => {
      const createStatements = sql.match(/CREATE\s+(TABLE|INDEX)/g) ?? [];
      const ifNotExists = sql.match(/IF NOT EXISTS/g) ?? [];
      expect(ifNotExists.length).toBeGreaterThanOrEqual(createStatements.length);
    });

    it("does not reference cross-context tables", () => {
      expect(sql).not.toContain("membership.");
      expect(sql).not.toContain("projects.");
      expect(sql).not.toContain("billing.");
      expect(sql).not.toContain("events.");
    });

    it("foreign keys stay within identity context", () => {
      const fkMatches = sql.match(/REFERENCES\s+(\w+)/g) ?? [];
      expect(fkMatches.length).toBeGreaterThan(0);
      for (const fk of fkMatches) {
        expect(fk).toMatch(/REFERENCES\s+identity_/);
      }
    });

    it("uses text primary keys holding UUIDs", () => {
      const pkMatches = sql.match(/id\s+TEXT\s+PRIMARY KEY/g) ?? [];
      expect(pkMatches.length).toBe(2); // service_principals + api_keys
    });

    it("API keys have status constraint (active/revoked/expired)", () => {
      expect(sql).toContain("api_keys_status_check");
    });

    it("service principals have status constraint (active/suspended/deleted)", () => {
      expect(sql).toContain("service_principals_status_check");
    });

    it("API keys support revocation tracking", () => {
      expect(sql).toContain("revoked_at");
      expect(sql).toContain("revoked_by");
    });

    it("API keys support expiry tracking", () => {
      expect(sql).toContain("expires_at");
    });

    it("API keys support usage tracking", () => {
      expect(sql).toContain("last_used_at");
    });
  });
});
