import { resolveBillingOrgHex } from "@billing-worker/billing-scope";
import type { Env } from "@billing-worker/env";

const ORG_HEX = "2f65ddde-1f5b-4e93-8c0b-80e030e31229";
const PARENT_HEX = "11111111-1111-1111-1111-111111111111";
const PARENT_PUB = "org_11111111111111111111111111111111";

function fetcher(body: unknown, status = 200): Fetcher {
  return {
    fetch: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

describe("resolveBillingOrgHex", () => {
  it("returns the parent hex when the org is a child", async () => {
    const env = { ENVIRONMENT: "test", MEMBERSHIP_WORKER: fetcher({ data: { billingOrgId: PARENT_PUB } }) } as unknown as Env;
    expect(await resolveBillingOrgHex(env, ORG_HEX, "req")).toBe(PARENT_HEX);
  });

  it("falls back to self when membership returns an error", async () => {
    const env = { ENVIRONMENT: "test", MEMBERSHIP_WORKER: fetcher("nope", 500) } as unknown as Env;
    expect(await resolveBillingOrgHex(env, ORG_HEX, "req")).toBe(ORG_HEX);
  });

  it("falls back to self when membership returns no billingOrgId", async () => {
    const env = { ENVIRONMENT: "test", MEMBERSHIP_WORKER: fetcher({ data: {} }) } as unknown as Env;
    expect(await resolveBillingOrgHex(env, ORG_HEX, "req")).toBe(ORG_HEX);
  });

  it("falls back to self when there is no membership binding", async () => {
    const env = { ENVIRONMENT: "test" } as Env;
    expect(await resolveBillingOrgHex(env, ORG_HEX, "req")).toBe(ORG_HEX);
  });
});
