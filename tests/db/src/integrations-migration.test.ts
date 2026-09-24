import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest, BOUNDED_CONTEXTS } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(
  __dirname,
  "../../..",
  "packages/db/src/migrations",
);

describe("Integrations Migration Verification", () => {
  const integrationsMigrations = manifest.migrations.filter(
    (m) => m.context === "integrations",
  );

  it("registers 'integrations' as a bounded context", () => {
    expect(BOUNDED_CONTEXTS).toContain("integrations");
  });

  it("has the 180_integrations_foundation migration", () => {
    expect(integrationsMigrations.map((m) => m.id)).toContain(
      "180_integrations_foundation",
    );
  });

  it("orders the integrations migrations at the manifest tail", () => {
    const ids = manifest.migrations.map((m) => m.id);
    expect(ids.indexOf("180_integrations_foundation")).toBe(ids.length - 2);
    expect(ids.indexOf("190_integrations_delivery_attribution")).toBe(ids.length - 1);
  });

  it("manifest checksums match the on-disk up.sql files", () => {
    for (const id of ["180_integrations_foundation", "190_integrations_delivery_attribution"]) {
      const entry = manifest.migrations.find((m) => m.id === id)!;
      const content = readFileSync(resolve(MIGRATIONS_ROOT, entry.path));
      const checksum = createHash("sha256").update(content).digest("hex");
      expect(entry.checksum).toBe(checksum);
    }
  });

  it("190 adds the connection pointer additively and idempotently", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "190_integrations_delivery_attribution/up.sql"),
      "utf-8",
    );
    // SQLite has no `ADD COLUMN IF NOT EXISTS`; re-run safety is the
    // runner's applied-ledger, and the column is a UUID held as TEXT.
    expect(sql).toContain("ADD COLUMN connection_id TEXT");
    expect(sql).toContain("idx_integrations_inbound_deliveries_connection");
    expect(sql).toContain("WHERE connection_id IS NOT NULL");
  });

  describe("integrations SQL schema validation", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "180_integrations_foundation/up.sql"),
      "utf-8",
    );

    it("namespaces its tables to the integrations context", () => {
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS integrations_");
    });

    it("creates the five foundation tables", () => {
      expect(sql).toContain("integrations_connections");
      expect(sql).toContain("integrations_github_installations");
      expect(sql).toContain("integrations_repo_links");
      expect(sql).toContain("integrations_inbound_deliveries");
      expect(sql).toContain("integrations_installation_tokens");
    });

    it("is idempotent (IF NOT EXISTS on every CREATE)", () => {
      const creates = sql.match(/^CREATE (TABLE|SCHEMA|INDEX|UNIQUE INDEX)/gm) ?? [];
      const guarded = sql.match(/^CREATE (?:TABLE|SCHEMA|INDEX|UNIQUE INDEX) IF NOT EXISTS/gm) ?? [];
      expect(creates.length).toBeGreaterThan(0);
      expect(guarded.length).toBe(creates.length);
    });

    it("enforces the delivery idempotency ledger (unique provider + delivery_key)", () => {
      expect(sql).toContain("uq_integrations_inbound_delivery_key");
      expect(sql).toMatch(/ON integrations_inbound_deliveries \(provider, delivery_key\)/);
    });

    it("enforces one active connection per (org, provider, account)", () => {
      expect(sql).toContain("uq_integrations_connection_active_account");
      expect(sql).toMatch(/WHERE status = 'active' AND external_account_id IS NOT NULL/);
    });

    it("enforces one active repo link per (project, repo)", () => {
      expect(sql).toContain("uq_integrations_repo_link_project_repo");
    });

    it("keeps the installation binding unique (tenancy keystone)", () => {
      expect(sql).toContain("uq_integrations_github_installation");
    });

    it("has keyset pagination indexes on org-scoped tables", () => {
      expect(sql).toMatch(/ON integrations_connections \(org_id, created_at DESC, id DESC\)/);
      expect(sql).toMatch(/ON integrations_repo_links \(org_id, created_at DESC, id DESC\)/);
      expect(sql).toMatch(/ON integrations_inbound_deliveries \(org_id, received_at DESC, id DESC\)/);
    });

    it("never stores platform GitHub credentials as rows", () => {
      // Cached installation tokens are ciphertext envelopes; the App private
      // key / webhook secret / client secret must not have columns.
      expect(sql).not.toMatch(/private_key/i);
      expect(sql).not.toMatch(/webhook_secret/i);
      expect(sql).not.toMatch(/client_secret/i);
      expect(sql).toContain("token_ciphertext");
    });
  });
});
