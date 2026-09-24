import type { D1Binding } from "./binding.js";
import { toBindValue, translatePlaceholders } from "./sql.js";

export interface SqlRow {
  [column: string]: unknown;
}

export interface SqlExecutorResult<T extends SqlRow = SqlRow> {
  rows: T[];
  rowCount: number;
}

export interface SqlExecutor {
  execute<T extends SqlRow = SqlRow>(
    text: string,
    params?: unknown[],
  ): Promise<SqlExecutorResult<T>>;
}

export interface TransactionalSqlExecutor extends SqlExecutor {
  transaction<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface SqlExecutorFactory {
  create(binding: D1Binding): SqlExecutor & { dispose(): Promise<void> };
}

/**
 * The one seam every repository talks to, backed by Cloudflare D1.
 *
 * D1 is a binding, not a connection: there is no pool to size, no socket to
 * reuse across requests, and nothing to dispose. `dispose()` is kept on the
 * shape so callers (and their `finally` blocks) are identical whatever backs
 * the executor.
 *
 * `rowCount` is `rows.length`, deliberately: statements whose outcome the
 * caller inspects use `RETURNING`, so the count is the number of rows the
 * statement actually produced. D1's `meta.changes` is not substituted for it —
 * that would silently change what `rowCount === 0` means for every existing
 * repository check.
 */
export function createSqlExecutor(
  binding: D1Binding,
): TransactionalSqlExecutor & { dispose(): Promise<void> } {
  async function execute<T extends SqlRow = SqlRow>(
    text: string,
    params?: unknown[],
  ): Promise<SqlExecutorResult<T>> {
    const { text: sql, values } = translatePlaceholders(text, params ?? []);
    const statement = binding.prepare(sql);
    const bound = values.length > 0 ? statement.bind(...values.map(toBindValue)) : statement;
    const result = await bound.all<T>();
    const rows = (result.results ?? []) as T[];
    return { rows, rowCount: rows.length };
  }

  return {
    execute,

    /**
     * D1 HAS NO INTERACTIVE TRANSACTIONS. Cloudflare's SQLite exposes atomic
     * `batch()` for a statement list decided up front; it cannot hold a
     * transaction open across the reads-then-writes a callback performs.
     *
     * So this runs the callback's statements in order against the same
     * database, with no rollback: a failure part-way leaves the earlier
     * statements applied. Callers that need all-or-nothing must reach for a
     * shape D1 can honor — a single statement with `RETURNING`, an upsert with
     * `ON CONFLICT`, or a compensating write on the error path.
     *
     * Kept as a method (rather than deleted) so the boundary stays visible in
     * the code that needs it: every `transaction(...)` call site is a place
     * where atomicity was wanted, and is where a reviewer should look first.
     */
    async transaction<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T> {
      return fn({ execute });
    },

    async dispose(): Promise<void> {
      // No connection to release — D1 bindings are stateless per request.
    },
  };
}
