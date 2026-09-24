import type { MigrationEntry } from "../types.js";

export interface AppliedMigration {
  id: string;
  context: string;
  checksum: string;
  applied_at: string;
}

export interface MigrationAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  acquireAdvisoryLock(lockId: number): Promise<boolean>;
  releaseAdvisoryLock(lockId: number): Promise<void>;
  getAppliedMigrations(): Promise<AppliedMigration[]>;
  beginTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  executeSql(sql: string): Promise<void>;
  recordMigration(entry: MigrationEntry): Promise<void>;
}

export type RunMode = "plan" | "apply";

export interface RunnerConfig {
  mode: RunMode;
  migrationsDir: string;
  adapter: MigrationAdapter | null;
}

export interface MigrationPlan {
  alreadyApplied: string[];
  pending: MigrationEntry[];
  checksumMismatches: Array<{ id: string; expected: string; actual: string }>;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  failed: { id: string; error: string } | null;
}
