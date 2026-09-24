import type { MigrationEntry } from "../types.js";
import type { AppliedMigration, MigrationAdapter } from "./types.js";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** How long a lock row may sit before a later runner reclaims it. A migration
 *  lane that outlives this was killed mid-flight; the ledger makes the retry
 *  safe. */
const LOCK_STALE_MS = 15 * 60 * 1000;

interface D1QueryResponse {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: Array<{ results?: Array<Record<string, unknown>>; success?: boolean }>;
}

/**
 * Applies migrations to a Cloudflare D1 database over the REST API.
 *
 * The CI lane has no Workers binding — it is a Node process — so it speaks to
 * D1 the way any external tool does: `POST /accounts/{account}/d1/database/
 * {database}/query`, authorized by an account API token scoped to D1 edit.
 *
 * Statements are sent one at a time on purpose: the failing statement is then
 * named exactly in the error, which is the difference between a five-second
 * fix and a bisect through a 200-line migration.
 */
export class D1ApiAdapter implements MigrationAdapter {
  private readonly accountId: string;
  private readonly databaseId: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private lockId: string | null = null;

  constructor(
    accountId: string,
    databaseId: string,
    apiToken: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.accountId = accountId;
    this.databaseId = databaseId;
    this.apiToken = apiToken;
    this.fetchImpl = fetchImpl;
  }

  private async query(
    sql: string,
    params: unknown[] = [],
  ): Promise<Array<Record<string, unknown>>> {
    const url = `${CLOUDFLARE_API}/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params }),
    });

    let body: D1QueryResponse;
    try {
      body = (await res.json()) as D1QueryResponse;
    } catch {
      throw new Error(`D1 API returned ${res.status} with a non-JSON body`);
    }

    if (!res.ok || body.success === false) {
      const detail = (body.errors ?? [])
        .map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim())
        .filter(Boolean)
        .join("; ");
      throw new Error(`D1 API error (${res.status}): ${detail || "unknown error"}`);
    }

    return body.result?.[0]?.results ?? [];
  }

  /** Split a migration file into statements on top-level semicolons, leaving
   *  semicolons inside string literals and `--` comments alone. */
  static splitStatements(sql: string): string[] {
    const out: string[] = [];
    let buf = "";
    let inString = false;
    let inComment = false;
    for (let i = 0; i < sql.length; i += 1) {
      const ch = sql[i]!;
      const next = sql[i + 1];
      if (inComment) {
        buf += ch;
        if (ch === "\n") inComment = false;
        continue;
      }
      if (!inString && ch === "-" && next === "-") {
        inComment = true;
        buf += ch;
        continue;
      }
      if (ch === "'") {
        inString = !inString;
        buf += ch;
        continue;
      }
      if (ch === ";" && !inString) {
        if (buf.trim()) out.push(buf.trim());
        buf = "";
        continue;
      }
      buf += ch;
    }
    if (buf.trim()) out.push(buf.trim());
    // Drop chunks that are only comments/whitespace.
    return out.filter((s) =>
      s.split("\n").some((line) => line.trim() && !line.trim().startsWith("--")),
    );
  }

  async connect(): Promise<void> {
    // The ledger and the lock table are the runner's own bookkeeping, created
    // before the first migration so an empty database is not a special case.
    await this.query(
      `CREATE TABLE IF NOT EXISTS _migrations_applied (
         id          TEXT PRIMARY KEY,
         context     TEXT NOT NULL,
         checksum    TEXT NOT NULL,
         applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
         applied_by  TEXT NOT NULL DEFAULT 'migration-runner'
       )`,
    );
    await this.query(
      `CREATE TABLE IF NOT EXISTS _migrations_lock (
         id          TEXT PRIMARY KEY,
         acquired_at TEXT NOT NULL
       )`,
    );
  }

  async disconnect(): Promise<void> {
    // Stateless HTTP — nothing to close.
  }

  /**
   * D1 has no advisory locks, so the mutex is a row: the winner is whoever
   * inserts it. A row older than LOCK_STALE_MS belongs to a runner that died,
   * and is reclaimed — the applied-ledger makes that safe, since a reclaiming
   * runner re-reads what actually landed rather than assuming.
   */
  async acquireAdvisoryLock(lockId: number): Promise<boolean> {
    const id = `migrate-${lockId}`;
    const stale = new Date(Date.now() - LOCK_STALE_MS).toISOString();
    await this.query(`DELETE FROM _migrations_lock WHERE id = ? AND acquired_at < ?`, [
      id,
      stale,
    ]);
    try {
      await this.query(`INSERT INTO _migrations_lock (id, acquired_at) VALUES (?, ?)`, [
        id,
        new Date().toISOString(),
      ]);
    } catch (err) {
      if (/(UNIQUE|PRIMARY KEY) constraint failed/i.test(String(err))) return false;
      throw err;
    }
    this.lockId = id;
    return true;
  }

  async releaseAdvisoryLock(lockId: number): Promise<void> {
    const id = this.lockId ?? `migrate-${lockId}`;
    await this.query(`DELETE FROM _migrations_lock WHERE id = ?`, [id]);
    this.lockId = null;
  }

  async getAppliedMigrations(): Promise<AppliedMigration[]> {
    const rows = await this.query(
      `SELECT id, context, checksum, applied_at FROM _migrations_applied ORDER BY id`,
    );
    return rows.map((r) => ({
      id: String(r.id),
      context: String(r.context),
      checksum: String(r.checksum),
      applied_at: String(r.applied_at),
    }));
  }

  // D1 exposes no interactive transaction over the REST API: a migration is
  // applied statement by statement and a failure part-way leaves the earlier
  // statements in place. That is survivable here — and only here — because
  // every migration is written idempotently (IF NOT EXISTS) and the ledger row
  // is written last, so a failed migration is simply re-attempted in full on
  // the next run. The no-ops keep the MigrationAdapter contract honest rather
  // than pretending a rollback happened.
  async beginTransaction(): Promise<void> {}
  async commitTransaction(): Promise<void> {}
  async rollbackTransaction(): Promise<void> {}

  async executeSql(sql: string): Promise<void> {
    const statements = D1ApiAdapter.splitStatements(sql);
    for (const statement of statements) {
      try {
        await this.query(statement);
      } catch (err) {
        const head = statement.split("\n").slice(0, 3).join(" ").slice(0, 200);
        throw new Error(`${err instanceof Error ? err.message : String(err)} — at: ${head}`);
      }
    }
  }

  async recordMigration(entry: MigrationEntry): Promise<void> {
    await this.query(
      `INSERT INTO _migrations_applied (id, context, checksum, applied_at, applied_by)
       VALUES (?, ?, ?, ?, 'db-migrate')
       ON CONFLICT (id) DO UPDATE SET checksum = excluded.checksum,
                                      applied_at = excluded.applied_at`,
      [entry.id, entry.context, entry.checksum, new Date().toISOString()],
    );
  }
}
