import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MigrationEntry, MigrationManifest } from "../types.js";
import type {
  MigrationPlan,
  MigrationResult,
  RunnerConfig,
} from "./types.js";

const ADVISORY_LOCK_ID = 839_201_008;

function computeChecksum(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export function buildPlan(
  manifest: MigrationManifest,
  appliedMap: Map<string, string>,
  migrationsDir: string,
): MigrationPlan {
  const alreadyApplied: string[] = [];
  const pending: MigrationEntry[] = [];
  const checksumMismatches: MigrationPlan["checksumMismatches"] = [];

  for (const entry of manifest.migrations) {
    const appliedChecksum = appliedMap.get(entry.id);

    if (appliedChecksum !== undefined) {
      alreadyApplied.push(entry.id);

      const fileChecksum = computeChecksum(
        resolve(migrationsDir, entry.path),
      );

      if (appliedChecksum !== fileChecksum || appliedChecksum !== entry.checksum) {
        checksumMismatches.push({
          id: entry.id,
          expected: appliedChecksum,
          actual: fileChecksum,
        });
      }
    } else {
      pending.push(entry);
    }
  }

  return { alreadyApplied, pending, checksumMismatches };
}

export async function runMigrations(
  manifest: MigrationManifest,
  config: RunnerConfig,
): Promise<MigrationResult> {
  const { adapter, mode, migrationsDir } = config;
  const result: MigrationResult = { applied: [], skipped: [], failed: null };

  // Offline plan: verify checksums then report all migrations as pending.
  if (mode === "plan" && adapter === null) {
    for (const entry of manifest.migrations) {
      const filePath = resolve(migrationsDir, entry.path);
      const fileChecksum = computeChecksum(filePath);
      if (fileChecksum !== entry.checksum) {
        throw new Error(
          `Checksum mismatch for ${entry.id}: manifest says ${entry.checksum}, file has ${fileChecksum}`,
        );
      }
    }
    result.applied = manifest.migrations.map((m) => m.id);
    return result;
  }

  if (!adapter) {
    throw new Error("adapter is required for apply mode");
  }

  await adapter.connect();

  try {
    const locked = await adapter.acquireAdvisoryLock(ADVISORY_LOCK_ID);
    if (!locked) {
      throw new Error(
        "Could not acquire migration advisory lock — another runner may be active",
      );
    }

    try {
      const appliedRows = await adapter.getAppliedMigrations();
      const appliedMap = new Map(appliedRows.map((r) => [r.id, r.checksum]));

      const plan = buildPlan(manifest, appliedMap, migrationsDir);

      if (plan.checksumMismatches.length > 0) {
        const ids = plan.checksumMismatches.map((m) => m.id).join(", ");
        throw new Error(
          `Checksum mismatch for already-applied migrations: ${ids}`,
        );
      }

      result.skipped = plan.alreadyApplied;

      if (mode === "plan") {
        result.applied = plan.pending.map((m) => m.id);
        return result;
      }

      for (const entry of plan.pending) {
        const sqlPath = resolve(migrationsDir, entry.path);
        const sql = readFileSync(sqlPath, "utf-8");
        const fileChecksum = computeChecksum(sqlPath);

        if (fileChecksum !== entry.checksum) {
          throw new Error(
            `Checksum mismatch for ${entry.id}: manifest says ${entry.checksum}, file has ${fileChecksum}`,
          );
        }

        await adapter.beginTransaction();
        try {
          await adapter.executeSql(sql);
          await adapter.recordMigration(entry);
          await adapter.commitTransaction();
          result.applied.push(entry.id);
        } catch (err: unknown) {
          await adapter.rollbackTransaction();
          const message = err instanceof Error ? err.message : String(err);
          result.failed = { id: entry.id, error: message };
          return result;
        }
      }
    } finally {
      await adapter.releaseAdvisoryLock(ADVISORY_LOCK_ID);
    }
  } finally {
    await adapter.disconnect();
  }

  return result;
}
