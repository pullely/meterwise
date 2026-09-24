import { handleFanOutPlan, parseFanOutBody } from "@billing-worker/handlers/fan-out";
import { route } from "@billing-worker/router";
import type { Env } from "@billing-worker/env";
import type { BillingRepository, BillingResult, Entitlement } from "@saas/db/billing";

const PARENT_PUB = "org_2f65ddde1f5b4e938c0b80e030e31229";
const PARENT_HEX = "2f65ddde-1f5b-4e93-8c0b-80e030e31229";
const CHILD_PUB = "org_11111111111111111111111111111111";
const CHILD_HEX = "11111111-1111-1111-1111-111111111111";
const env = { ENVIRONMENT: "test" } as Env;

function ent(key: string, valueType: "boolean" | "quantity", enabled: boolean, limitValue: number | null): Entitlement {
  return {
    id: "e",
    orgId: PARENT_HEX,
    subscriptionId: null,
    entitlementKey: key,
    valueType,
    enabled,
    limitValue,
    source: "plan",
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Entitlement;
}

type RepoSlice = Pick<BillingRepository, "listEntitlements" | "upsertEntitlement">;

function fakeRepo(parentEnts: Entitlement[]) {
  const childUpserts: Array<{ orgId: string; key: string; enabled: boolean; limitValue: number | null }> = [];
  const repo: RepoSlice = {
    listEntitlements: async (q): Promise<BillingResult<Entitlement[]>> => ({
      ok: true,
      value: q.orgId === PARENT_HEX ? parentEnts : [],
    }),
    upsertEntitlement: async (i): Promise<BillingResult<Entitlement>> => {
      childUpserts.push({ orgId: i.orgId, key: i.entitlementKey, enabled: i.enabled ?? true, limitValue: i.limitValue ?? null });
      return { ok: true, value: {} as Entitlement };
    },
  };
  return { repo, childUpserts };
}

function fanOutReq(body: unknown): Request {
  return new Request("https://billing/v1/internal/billing/plan/fan-out", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-caller": "membership-worker" },
    body: JSON.stringify(body),
  });
}

describe("parseFanOutBody", () => {
  it("rejects missing fields / malformed / identical ids", () => {
    expect("error" in parseFanOutBody({})).toBe(true);
    expect("error" in parseFanOutBody({ parentOrgId: PARENT_PUB })).toBe(true);
    expect("error" in parseFanOutBody({ parentOrgId: "nope", childOrgId: CHILD_PUB })).toBe(true);
    expect("error" in parseFanOutBody({ parentOrgId: PARENT_PUB, childOrgId: PARENT_PUB })).toBe(true);
  });
  it("accepts a well-formed pair and maps to hex", () => {
    const p = parseFanOutBody({ parentOrgId: PARENT_PUB, childOrgId: CHILD_PUB });
    expect(p).toEqual({ parentOrgId: PARENT_PUB, childOrgId: CHILD_PUB, parentHex: PARENT_HEX, childHex: CHILD_HEX });
  });
});

describe("handleFanOutPlan", () => {
  it("copies the parent's plan entitlements onto the child", async () => {
    const { repo, childUpserts } = fakeRepo([
      ent("limit.projects", "quantity", true, 100),
      ent("feature.multi_org", "boolean", true, null),
    ]);
    const res = await handleFanOutPlan(fanOutReq({ parentOrgId: PARENT_PUB, childOrgId: CHILD_PUB }), env, "req_t", {
      repoFactory: () => repo,
      generateId: ((c) => () => `id_${++c}`)(0),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entitlementsCopied: number } };
    expect(body.data.entitlementsCopied).toBe(2);
    expect(childUpserts.every((u) => u.orgId === CHILD_HEX)).toBe(true);
    expect(childUpserts.map((u) => u.key).sort()).toEqual(["feature.multi_org", "limit.projects"]);
    expect(childUpserts.find((u) => u.key === "limit.projects")!.limitValue).toBe(100);
  });

  it("returns 400 on a malformed body", async () => {
    const { repo } = fakeRepo([]);
    const res = await handleFanOutPlan(fanOutReq({ parentOrgId: PARENT_PUB }), env, "req_t", { repoFactory: () => repo });
    expect(res.status).toBe(400);
  });
});

describe("fan-out route auth", () => {
  it("rejects the fan-out route without a valid x-internal-caller (403)", async () => {
    const req = new Request("https://billing/v1/internal/billing/plan/fan-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentOrgId: PARENT_PUB, childOrgId: CHILD_PUB }),
    });
    const res = await route(req, env);
    expect(res.status).toBe(403);
  });
});
