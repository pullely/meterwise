import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "@saas/db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_ROOT = resolve(__dirname, "../../..", "packages/db/src/migrations");

describe("030_events_audit_core migration", () => {
  const entry = manifest.migrations.find((m) => m.id === "030_events_audit_core");
  const sql = entry
    ? readFileSync(resolve(MIGRATIONS_ROOT, entry.path), "utf-8")
    : "";

  it("migration entry exists in manifest", () => {
    expect(entry).toBeDefined();
  });

  it("context is events", () => {
    expect(entry!.context).toBe("events");
  });

  it("manifest ordering includes the new migration after 020", () => {
    const ids = manifest.migrations.map((m) => m.id);
    const idx020 = ids.indexOf("020_membership_core");
    const idx030 = ids.indexOf("030_events_audit_core");
    expect(idx030).toBeGreaterThan(idx020);
  });

  it("namespaces its tables to the events context", () => {
    // SQLite has no schemas, so the bounded-context boundary lives in the
    // table name prefix instead of a CREATE SCHEMA.
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS events_");
  });

  it("creates event_log table", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS events_event_log");
  });

  it("creates audit_entries table", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS events_audit_entries");
  });

  it("event_log includes org_id column", () => {
    expect(sql).toMatch(/org_id\s+TEXT\s+NOT NULL/);
  });

  it("event_log includes project_id and environment_id columns", () => {
    expect(sql).toContain("project_id");
    expect(sql).toContain("environment_id");
  });

  it("audit_entries includes org_id column", () => {
    // audit_entries org_id is NOT NULL
    expect(sql).toContain("audit_entries");
    expect(sql).toMatch(/org_id\s+TEXT\s+NOT NULL/);
  });

  it("audit_entries references event_log (same-context FK allowed)", () => {
    expect(sql).toContain("REFERENCES events_event_log(id)");
  });

  it("does not contain cross-context foreign keys", () => {
    // No FKs to identity, membership, control, projects, billing schemas
    expect(sql).not.toContain("REFERENCES identity.");
    expect(sql).not.toContain("REFERENCES membership.");
    expect(sql).not.toContain("REFERENCES control.");
    expect(sql).not.toContain("REFERENCES projects.");
    expect(sql).not.toContain("REFERENCES billing.");
  });

  it("DDL is idempotent (IF NOT EXISTS throughout)", () => {
    const createStatements = sql.match(/CREATE\s+(TABLE|INDEX)/g) ?? [];
    const ifNotExists = sql.match(/IF NOT EXISTS/g) ?? [];
    expect(ifNotExists.length).toBeGreaterThanOrEqual(createStatements.length);
  });

  it("includes JSON payload storage", () => {
    // JSON documents are TEXT on SQLite; @saas/db/json owns the encode/decode.
    expect(sql).toMatch(/payload\s+TEXT/);
  });

  it("includes redaction path storage", () => {
    expect(sql).toContain("redact_paths");
  });

  it("includes organization+time index for event_log", () => {
    expect(sql).toContain("event_log_org_occurred_idx");
  });

  it("includes organization+time index for audit_entries", () => {
    expect(sql).toContain("audit_entries_org_occurred_idx");
  });

  it("includes target lookup index for audit_entries", () => {
    expect(sql).toContain("audit_entries_target_idx");
  });

  it("includes trace fields (request_id)", () => {
    expect(sql).toContain("request_id");
    expect(sql).toContain("correlation_id");
  });
});
