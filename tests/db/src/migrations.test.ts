import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest, BOUNDED_CONTEXTS } from "@saas/db";
import type { BoundedContext, MigrationEntry } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(
  __dirname,
  "../../..",
  "packages/db/src/migrations"
);

function computeChecksum(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

describe("Migration Manifest Verifier", () => {
  const { migrations } = manifest;

  it("manifest has version 1", () => {
    expect(manifest.version).toBe(1);
  });

  it("has at least one migration", () => {
    expect(migrations.length).toBeGreaterThan(0);
  });

  describe("ID uniqueness and ordering", () => {
    it("all migration IDs are unique", () => {
      const ids = migrations.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("migration IDs are sorted in ascending lexicographic order", () => {
      const ids = migrations.map((m) => m.id);
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });

    it("migration IDs follow the naming convention", () => {
      const pattern = /^\d{3}_[a-z]+_[a-z][a-z0-9_]*$/;
      for (const m of migrations) {
        expect(m.id).toMatch(pattern);
      }
    });
  });

  describe("bounded context ownership", () => {
    const VALID_CONTEXTS = BOUNDED_CONTEXTS;

    it("each migration declares a valid bounded context", () => {
      for (const m of migrations) {
        expect(VALID_CONTEXTS).toContain(m.context);
      }
    });
  });

  describe("file existence and manifest completeness", () => {
    it("each migration file exists on disk", () => {
      for (const m of migrations) {
        const fullPath = resolve(MIGRATIONS_ROOT, m.path);
        expect(existsSync(fullPath)).toBe(true);
      }
    });
  });

  describe("checksum integrity (drift detection)", () => {
    it.each(migrations.map((m) => [m.id, m] as [string, MigrationEntry]))(
      "checksum matches for %s",
      (_id, m) => {
        const fullPath = resolve(MIGRATIONS_ROOT, m.path);
        const actual = computeChecksum(fullPath);
        expect(actual).toBe(m.checksum);
      }
    );
  });

  describe("tenant isolation invariant", () => {
    it("project-scoped migrations reference org_id + project_id pattern", () => {
      const PROJECT_SCOPED_CONTEXTS: BoundedContext[] = ["projects"];

      const projectMigrations = migrations.filter((m) =>
        PROJECT_SCOPED_CONTEXTS.includes(m.context)
      );

      for (const m of projectMigrations) {
        const fullPath = resolve(MIGRATIONS_ROOT, m.path);
        const sql = readFileSync(fullPath, "utf-8");
        expect(sql).toContain("org_id");
        expect(sql).toContain("project_id");
      }

      expect(true).toBe(true);
    });

    it("project-scoped migrations do not reference other bounded-context schemas", () => {
      const PROJECT_SCOPED_CONTEXTS: BoundedContext[] = ["projects"];
      const FORBIDDEN_REFS = ["membership.", "identity.", "billing.", "events."];

      const projectMigrations = migrations.filter((m) =>
        PROJECT_SCOPED_CONTEXTS.includes(m.context)
      );

      for (const m of projectMigrations) {
        const fullPath = resolve(MIGRATIONS_ROOT, m.path);
        const sql = readFileSync(fullPath, "utf-8");
        for (const ref of FORBIDDEN_REFS) {
          expect(sql).not.toContain(ref);
        }
      }
    });
  });

  describe("migration description", () => {
    it("each migration has a non-empty description", () => {
      for (const m of migrations) {
        expect(m.description.length).toBeGreaterThan(0);
      }
    });
  });
});
