import { createD1Adapter, type D1Binding, type DbHealthResult } from "@saas/db/d1";
import { isUniqueViolation } from "@saas/db/d1";

function bindingThat(outcome: () => Promise<unknown>): D1Binding {
  return {
    prepare() {
      const statement = {
        bind() {
          return statement;
        },
        all: outcome as () => Promise<{ results?: Record<string, unknown>[] }>,
      };
      return statement;
    },
  } as unknown as D1Binding;
}

describe("createD1Adapter", () => {
  it("reports not-configured when the binding is absent", async () => {
    // A worker deployed to an environment whose wrangler config has no
    // d1_databases entry: an operator/wiring problem, distinct from a
    // database that is present but unreachable.
    const result: DbHealthResult = await createD1Adapter(undefined).ping();
    expect(result).toEqual({ configured: false, reachable: false });
  });

  it("reports configured and reachable when the probe returns", async () => {
    let asked = false;
    const binding = bindingThat(() => {
      asked = true;
      return Promise.resolve({ results: [{ ok: 1 }] });
    });

    expect(await createD1Adapter(binding).ping()).toEqual({
      configured: true,
      reachable: true,
    });
    expect(asked).toBe(true);
  });

  it("reports configured but unreachable when the probe throws", async () => {
    const binding = bindingThat(() => Promise.reject(new Error("D1_ERROR: network")));
    expect(await createD1Adapter(binding).ping()).toEqual({
      configured: true,
      reachable: false,
    });
  });

  it("never leaks the underlying error out of ping", async () => {
    const binding = bindingThat(() =>
      Promise.reject(new Error("D1_ERROR: authentication failure token=secret")),
    );
    await expect(createD1Adapter(binding).ping()).resolves.toBeDefined();
  });

  it("dispose resolves", async () => {
    await expect(createD1Adapter(undefined).dispose()).resolves.toBeUndefined();
  });
});

describe("isUniqueViolation", () => {
  it("recognizes SQLite's unique constraint message", () => {
    expect(
      isUniqueViolation(new Error("D1_ERROR: UNIQUE constraint failed: identity_users.email_lower")),
    ).toBe(true);
  });

  it("recognizes a primary key collision", () => {
    expect(isUniqueViolation(new Error("PRIMARY KEY constraint failed: membership_organizations.id"))).toBe(
      true,
    );
  });

  it("reads the message off a plain error-shaped object", () => {
    expect(isUniqueViolation({ message: "UNIQUE constraint failed: t.c" })).toBe(true);
  });

  it("does not claim unrelated failures", () => {
    expect(isUniqueViolation(new Error("no such table: identity_users"))).toBe(false);
    expect(isUniqueViolation(new Error("FOREIGN KEY constraint failed"))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});
