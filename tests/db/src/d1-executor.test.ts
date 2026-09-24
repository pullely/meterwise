import { createSqlExecutor, type D1Binding } from "@saas/db/d1";

interface Call {
  sql: string;
  values: unknown[];
}

/** A D1 binding double that records what it was asked to run. */
function fakeBinding(
  rowsFor: (sql: string, values: unknown[]) => Array<Record<string, unknown>> | Error = () => [],
): D1Binding & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    prepare(sql: string) {
      let bound: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        all() {
          calls.push({ sql, values: bound });
          const outcome = rowsFor(sql, bound);
          if (outcome instanceof Error) return Promise.reject(outcome);
          return Promise.resolve({ results: outcome, success: true });
        },
      };
      return statement;
    },
  } as D1Binding & { calls: Call[] };
}

describe("createSqlExecutor (D1)", () => {
  it("binds numbered placeholders positionally and returns the rows", async () => {
    const binding = fakeBinding(() => [{ id: "u-001", name: "test" }]);
    const executor = createSqlExecutor(binding);

    const result = await executor.execute(
      "SELECT * FROM identity_users WHERE id = $1 AND status = $2",
      ["u-001", "active"],
    );

    expect(binding.calls[0]!.sql).toBe(
      "SELECT * FROM identity_users WHERE id = ? AND status = ?",
    );
    expect(binding.calls[0]!.values).toEqual(["u-001", "active"]);
    expect(result.rows).toEqual([{ id: "u-001", name: "test" }]);
    expect(result.rowCount).toBe(1);

    await executor.dispose();
  });

  it("runs a statement with no parameters without calling bind", async () => {
    const binding = fakeBinding(() => [{ ok: 1 }]);
    const executor = createSqlExecutor(binding);

    const result = await executor.execute("SELECT 1 AS ok");

    expect(binding.calls[0]!.values).toEqual([]);
    expect(result.rowCount).toBe(1);
  });

  it("normalizes bind values that SQLite cannot store natively", async () => {
    const binding = fakeBinding(() => []);
    const executor = createSqlExecutor(binding);

    await executor.execute("INSERT INTO t (a, b, c, d) VALUES ($1, $2, $3, $4)", [
      new Date("2026-01-01T00:00:00.000Z"),
      true,
      { nested: 1 },
      undefined,
    ]);

    expect(binding.calls[0]!.values).toEqual([
      "2026-01-01T00:00:00.000Z",
      1,
      '{"nested":1}',
      null,
    ]);
  });

  it("reports an empty result as zero rows rather than throwing", async () => {
    const executor = createSqlExecutor(fakeBinding(() => []));
    const result = await executor.execute("SELECT * FROM identity_users WHERE id = $1", ["nope"]);
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
  });

  it("propagates a query failure to the caller", async () => {
    const executor = createSqlExecutor(
      fakeBinding(() => new Error("D1_ERROR: no such table: identity_users")),
    );
    await expect(executor.execute("SELECT 1")).rejects.toThrow(/no such table/);
  });

  describe("transaction", () => {
    it("runs the callback's statements against the same database", async () => {
      const binding = fakeBinding(() => [{ id: "row-1" }]);
      const executor = createSqlExecutor(binding);

      const rows = await executor.transaction(async (tx) => {
        const r = await tx.execute("INSERT INTO foo VALUES ($1) RETURNING *", ["bar"]);
        return r.rows;
      });

      expect(rows).toEqual([{ id: "row-1" }]);
      expect(binding.calls[0]!.sql).toBe("INSERT INTO foo VALUES (?) RETURNING *");
    });

    it("returns the callback's value", async () => {
      const executor = createSqlExecutor(fakeBinding());
      await expect(executor.transaction(async () => "committed")).resolves.toBe("committed");
    });

    it("propagates a thrown callback", async () => {
      const executor = createSqlExecutor(fakeBinding());
      await expect(
        executor.transaction(async () => {
          throw new Error("business logic failed");
        }),
      ).rejects.toThrow("business logic failed");
    });

    it("does NOT roll back — D1 has no interactive transaction", async () => {
      // This is the documented constraint of the Cloudflare-only baseline,
      // asserted so a future change to the executor cannot quietly weaken
      // (or silently claim to strengthen) it. The first write stays applied.
      const binding = fakeBinding(() => []);
      const executor = createSqlExecutor(binding);

      await expect(
        executor.transaction(async (tx) => {
          await tx.execute("INSERT INTO foo VALUES ($1)", ["first"]);
          throw new Error("second step failed");
        }),
      ).rejects.toThrow("second step failed");

      expect(binding.calls).toHaveLength(1);
      expect(binding.calls[0]!.values).toEqual(["first"]);
    });
  });

  describe("Worker-safe export surface", () => {
    it("exports the executor and adapter without dragging in the migration runner", async () => {
      const mod = await import("@saas/db/d1");
      const keys = Object.keys(mod);

      expect(keys).toContain("createSqlExecutor");
      expect(keys).toContain("createD1Adapter");
      expect(keys).not.toContain("runMigrations");
      expect(keys).not.toContain("D1ApiAdapter");
      expect(keys).not.toContain("loadD1CredentialsFromEnv");
    });

    it("dispose resolves — a D1 binding holds nothing to release", async () => {
      const executor = createSqlExecutor(fakeBinding());
      await expect(executor.dispose()).resolves.toBeUndefined();
    });
  });
});
