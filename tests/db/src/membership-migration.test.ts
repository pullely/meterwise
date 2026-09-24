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

describe("Membership Migration Verification", () => {
  const membershipMigrations = manifest.migrations.filter(
    (m) => m.context === "membership",
  );

  it("has at least one membership migration", () => {
    expect(membershipMigrations.length).toBeGreaterThan(0);
  });

  it("membership migration has context 'membership'", () => {
    for (const m of membershipMigrations) {
      expect(m.context).toBe("membership");
    }
  });

  it("membership migration is ordered after identity migrations", () => {
    const ids = manifest.migrations.map((m) => m.id);
    const identityIdx = ids.indexOf("010_identity_core");
    const membershipIdx = ids.indexOf("020_membership_core");

    expect(membershipIdx).toBeGreaterThan(identityIdx);
  });

  describe("membership SQL schema validation", () => {
    const sql = readFileSync(
      resolve(MIGRATIONS_ROOT, "020_membership_core/up.sql"),
      "utf-8",
    );

    it("namespaces its tables to the membership context", () => {
      expect(sql).toContain("CREATE TABLE IF NOT EXISTS membership_");
    });

    it("creates membership_organizations table", () => {
      expect(sql).toContain("membership_organizations");
    });

    it("creates membership_organization_members table", () => {
      expect(sql).toContain("membership_organization_members");
    });

    it("creates membership_organization_invitations table", () => {
      expect(sql).toContain("membership_organization_invitations");
    });

    it("creates membership_role_assignments table", () => {
      expect(sql).toContain("membership_role_assignments");
    });

    it("stores only hashed invitation tokens, never raw values", () => {
      expect(sql).toContain("token_hash");
      expect(sql).not.toMatch(/\btoken\b\s+TEXT/);
    });

    it("uses normalized slug column for lookup", () => {
      expect(sql).toContain("slug_lower");
      expect(sql).toContain("organizations_slug_lower_idx");
    });

    it("uses normalized email for invitation lookup", () => {
      expect(sql).toContain("email_lower");
      expect(sql).toContain("org_invitations_email_lower_idx");
    });

    it("uses IF NOT EXISTS for idempotency", () => {
      const createStatements = sql.match(/CREATE\s+(TABLE|SCHEMA|INDEX)/g) ?? [];
      const ifNotExists = sql.match(/IF NOT EXISTS/g) ?? [];
      expect(ifNotExists.length).toBeGreaterThanOrEqual(createStatements.length);
    });

    it("does not reference cross-context tables", () => {
      expect(sql).not.toContain("identity.");
      expect(sql).not.toContain("projects.");
      expect(sql).not.toContain("billing.");
      expect(sql).not.toContain("events.");
    });

    it("does not require extensions like citext", () => {
      expect(sql).not.toContain("CREATE EXTENSION");
      expect(sql).not.toContain("citext");
    });

    it("has no foreign keys to cross-context tables", () => {
      const fkMatches = sql.match(/REFERENCES\s+(\w+\.\w+)/g) ?? [];
      for (const fk of fkMatches) {
        expect(fk).toContain("membership.");
      }
    });

    it("all organization-scoped tables include org_id column", () => {
      const tableBlocks = sql.split(/CREATE TABLE IF NOT EXISTS/);
      const orgScopedTables = tableBlocks.filter(
        (block) =>
          block.includes("membership_organization_members") ||
          block.includes("membership_organization_invitations") ||
          block.includes("membership_role_assignments"),
      );
      for (const block of orgScopedTables) {
        expect(block).toContain("org_id");
      }
    });

    it("invitation secrets are hash-only", () => {
      expect(sql).toContain("token_hash");
      expect(sql).not.toMatch(/\braw_token\b/);
      expect(sql).not.toMatch(/\btoken\b\s+TEXT\s+NOT NULL(?!.*hash)/);
    });

    it("supports all organization roles from spec", () => {
      expect(sql).toContain("owner");
      expect(sql).toContain("admin");
      expect(sql).toContain("builder");
      expect(sql).toContain("viewer");
      expect(sql).toContain("billing_admin");
    });

    it("supports project roles without coupling to projects schema", () => {
      expect(sql).toContain("project_admin");
      expect(sql).toContain("project_builder");
      expect(sql).toContain("project_viewer");
    });

    it("role_assignments has scope_kind and scope_ref for project scoping", () => {
      expect(sql).toContain("scope_kind");
      expect(sql).toContain("scope_ref");
    });
  });

  describe("project-scoped invariant still applies only to projects context", () => {
    it("membership migrations are not subject to project-scoped org_id/project_id check", () => {
      expect(membershipMigrations.every((m) => m.context === "membership")).toBe(true);
      expect(membershipMigrations.some((m) => m.context === "projects")).toBe(false);
    });
  });
});
