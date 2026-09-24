import { handleSyncAccountChildren, parseSyncBody } from "@membership-worker/handlers/sync-account-children";
import { route } from "@membership-worker/router";
import type { Env } from "@membership-worker/env";
import type { MembershipRepository, MembershipResult, Organization } from "@saas/db/membership";

const PARENT_PUB = "org_2f65ddde1f5b4e938c0b80e030e31229";
const env = { ENVIRONMENT: "test" } as Env;

function org(id: string): Organization {
  return {
    id,
    name: "Child",
    slug: id.slice(0, 8),
    slugLower: id.slice(0, 8),
    status: "active",
    parentOrgId: "2f65ddde-1f5b-4e93-8c0b-80e030e31229",
    createdAt: new Date("2026-02-01T00:00:00Z"),
    updatedAt: new Date("2026-02-01T00:00:00Z"),
  };
}

const CHILDREN = [org("11111111-1111-1111-1111-111111111111"), org("22222222-2222-2222-2222-222222222222")];

type RepoSlice = Pick<MembershipRepository, "listChildOrganizations" | "setOrganizationStatus">;

function makeDeps() {
  const statusSets: Array<{ id: string; status: string }> = [];
  const fanOuts: Array<{ parent: string; child: string }> = [];
  const repo: RepoSlice = {
    listChildOrganizations: async (): Promise<MembershipResult<Organization[]>> => ({ ok: true, value: CHILDREN }),
    setOrganizationStatus: async (id, status): Promise<MembershipResult<Organization>> => {
      statusSets.push({ id, status });
      return { ok: true, value: { ...org(id), status } };
    },
  };
  return {
    deps: {
      repo,
      fanOut: async (parent: string, child: string) => {
        fanOuts.push({ parent, child });
        return { kind: "ok" as const };
      },
    },
    statusSets,
    fanOuts,
  };
}

function syncReq(body: unknown): Request {
  return new Request("https://membership/v1/internal/membership/account/children-sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("parseSyncBody", () => {
  it("rejects missing/invalid mode and malformed parent", () => {
    expect("error" in parseSyncBody({ parentOrgId: PARENT_PUB })).toBe(true);
    expect("error" in parseSyncBody({ parentOrgId: PARENT_PUB, mode: "nope" })).toBe(true);
    expect("error" in parseSyncBody({ parentOrgId: "bad", mode: "freeze" })).toBe(true);
  });
});

describe("handleSyncAccountChildren", () => {
  it("freeze: suspends every child", async () => {
    const { deps, statusSets, fanOuts } = makeDeps();
    const res = await handleSyncAccountChildren(syncReq({ parentOrgId: PARENT_PUB, mode: "freeze" }), env, "req_t", deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { childrenSynced: number } };
    expect(body.data.childrenSynced).toBe(2);
    expect(statusSets).toEqual([
      { id: CHILDREN[0]!.id, status: "suspended" },
      { id: CHILDREN[1]!.id, status: "suspended" },
    ]);
    expect(fanOuts).toHaveLength(0);
  });

  it("refanout: reactivates each child and fans out the parent plan", async () => {
    const { deps, statusSets, fanOuts } = makeDeps();
    const res = await handleSyncAccountChildren(syncReq({ parentOrgId: PARENT_PUB, mode: "refanout" }), env, "req_t", deps);
    expect(res.status).toBe(200);
    expect(statusSets.every((s) => s.status === "active")).toBe(true);
    expect(fanOuts).toHaveLength(2);
    expect(fanOuts.every((f) => f.parent === PARENT_PUB)).toBe(true);
    expect(fanOuts.map((f) => f.child).sort()).toEqual([
      "org_11111111111111111111111111111111",
      "org_22222222222222222222222222222222",
    ]);
  });

  it("returns 400 on an invalid mode", async () => {
    const { deps } = makeDeps();
    const res = await handleSyncAccountChildren(syncReq({ parentOrgId: PARENT_PUB, mode: "x" }), env, "req_t", deps);
    expect(res.status).toBe(400);
  });

  it("is routed at the internal children-sync path", async () => {
    const res = await route(syncReq({ parentOrgId: PARENT_PUB, mode: "freeze" }), env);
    // No DB configured in env → 503 (not 404), proving the route matched.
    expect(res.status).toBe(503);
  });
});
