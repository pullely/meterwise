import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@saas/db";
import type { MigrationEntry } from "@saas/db";
import { buildPlan, runMigrations } from "@saas/db/runner";
import type {
  AppliedMigration,
  MigrationAdapter,
  MigrationPlan,
} from "@saas/db/runner";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../..", "packages/db/src/migrations");

class FakeAdapter implements MigrationAdapter {
  connected = false;
  locked = false;
  appliedMigrations: AppliedMigration[] = [];
  executedSql: string[] = [];
  recorded: MigrationEntry[] = [];
  inTransaction = false;
  shouldFailOnSql: string | null = null;
  lockAcquirable = true;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async acquireAdvisoryLock(_lockId: number): Promise<boolean> {
    if (!this.lockAcquirable) return false;
    this.locked = true;
    return true;
  }

  async releaseAdvisoryLock(_lockId: number): Promise<void> {
    this.locked = false;
  }

  async getAppliedMigrations(): Promise<AppliedMigration[]> {
    return this.appliedMigrations;
  }

  async beginTransaction(): Promise<void> {
    this.inTransaction = true;
  }

  async commitTransaction(): Promise<void> {
    this.inTransaction = false;
  }

  async rollbackTransaction(): Promise<void> {
    this.inTransaction = false;
  }

  async executeSql(sql: string): Promise<void> {
    if (this.shouldFailOnSql && sql.includes(this.shouldFailOnSql)) {
      throw new Error(`Simulated SQL failure on: ${this.shouldFailOnSql}`);
    }
    this.executedSql.push(sql);
  }

  async recordMigration(entry: MigrationEntry): Promise<void> {
    this.recorded.push(entry);
    this.appliedMigrations.push({
      id: entry.id,
      context: entry.context,
      checksum: entry.checksum,
      applied_at: new Date().toISOString(),
    });
  }
}

describe("Migration Runner", () => {
  let adapter: FakeAdapter;

  const firstMigration = manifest.migrations[0]!;

  beforeEach(() => {
    adapter = new FakeAdapter();
  });

  describe("no pending migrations", () => {
    it("reports all migrations as skipped when fully applied", async () => {
      adapter.appliedMigrations = manifest.migrations.map((m) => ({
        id: m.id,
        context: m.context,
        checksum: m.checksum,
        applied_at: "2026-01-01T00:00:00Z",
      }));

      const result = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(result.applied).toHaveLength(0);
      expect(result.skipped).toEqual(manifest.migrations.map((m) => m.id));
      expect(result.failed).toBeNull();
    });

    it("is idempotent when re-run with no pending migrations", async () => {
      adapter.appliedMigrations = manifest.migrations.map((m) => ({
        id: m.id,
        context: m.context,
        checksum: m.checksum,
        applied_at: "2026-01-01T00:00:00Z",
      }));

      const result1 = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });
      const result2 = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(result1).toEqual(result2);
    });
  });

  describe("pending migrations", () => {
    it("applies all pending migrations in manifest order", async () => {
      const result = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(result.applied).toEqual(manifest.migrations.map((m) => m.id));
      expect(result.skipped).toHaveLength(0);
      expect(result.failed).toBeNull();
      expect(adapter.recorded).toHaveLength(manifest.migrations.length);
    });

    it("applies only missing migrations when some are already applied", async () => {
      adapter.appliedMigrations = [
        {
          id: firstMigration.id,
          context: firstMigration.context,
          checksum: firstMigration.checksum,
          applied_at: "2026-01-01T00:00:00Z",
        },
      ];

      const result = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(result.skipped).toContain(firstMigration.id);
      expect(result.applied).toEqual(
        manifest.migrations.slice(1).map((m) => m.id),
      );
      expect(result.failed).toBeNull();
    });
  });

  describe("plan mode", () => {
    it("reports pending migrations without executing SQL", async () => {
      const result = await runMigrations(manifest, {
        mode: "plan",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(result.applied).toEqual(manifest.migrations.map((m) => m.id));
      expect(adapter.executedSql).toHaveLength(0);
      expect(adapter.recorded).toHaveLength(0);
    });
  });

  describe("checksum mismatch", () => {
    it("fails when an applied migration has a different checksum", async () => {
      adapter.appliedMigrations = [
        {
          id: firstMigration.id,
          context: firstMigration.context,
          checksum: "0000000000000000000000000000000000000000000000000000000000000000",
          applied_at: "2026-01-01T00:00:00Z",
        },
      ];

      await expect(
        runMigrations(manifest, {
          mode: "apply",
          migrationsDir: MIGRATIONS_DIR,
          adapter,
        }),
      ).rejects.toThrow("Checksum mismatch for already-applied migrations");
    });
  });

  describe("migration failure rollback", () => {
    it("rolls back the failed migration and reports the error", async () => {
      adapter.shouldFailOnSql = "CREATE TABLE";

      const result = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(result.failed).not.toBeNull();
      expect(result.failed!.id).toBe(firstMigration.id);
      expect(result.failed!.error).toContain("Simulated SQL failure");
      expect(adapter.inTransaction).toBe(false);
    });
  });

  describe("deterministic apply order", () => {
    it("applies migrations in manifest array order", async () => {
      const result = await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      for (let i = 0; i < result.applied.length; i++) {
        expect(result.applied[i]).toBe(manifest.migrations[i]!.id);
      }
    });
  });

  describe("advisory lock", () => {
    it("fails when advisory lock cannot be acquired", async () => {
      adapter.lockAcquirable = false;

      await expect(
        runMigrations(manifest, {
          mode: "apply",
          migrationsDir: MIGRATIONS_DIR,
          adapter,
        }),
      ).rejects.toThrow("Could not acquire migration advisory lock");
    });

    it("releases lock even when migration fails", async () => {
      adapter.shouldFailOnSql = "CREATE TABLE";

      await runMigrations(manifest, {
        mode: "apply",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(adapter.locked).toBe(false);
    });
  });

  describe("connection lifecycle", () => {
    it("connects before running and disconnects after", async () => {
      await runMigrations(manifest, {
        mode: "plan",
        migrationsDir: MIGRATIONS_DIR,
        adapter,
      });

      expect(adapter.connected).toBe(false);
    });
  });
});

describe("buildPlan", () => {
  it("identifies pending, applied, and mismatched migrations", () => {
    const first = manifest.migrations[0]!;
    const appliedMap = new Map([
      [first.id, first.checksum],
    ]);

    const plan: MigrationPlan = buildPlan(manifest, appliedMap, MIGRATIONS_DIR);

    expect(plan.alreadyApplied).toContain(first.id);
    expect(plan.checksumMismatches).toHaveLength(0);
    expect(plan.pending).toEqual(manifest.migrations.slice(1));
  });
});
