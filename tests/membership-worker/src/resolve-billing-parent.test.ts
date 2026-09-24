import { handleResolveBillingParent } from "@membership-worker/handlers/resolve-billing-parent";
import type { Env } from "@membership-worker/env";
import type { Organization, MembershipResult } from "@saas/db/membership";

const env = { ENVIRONMENT: "test" } as Env;
const ORG_HEX = "2f65ddde-1f5b-4e93-8c0b-80e030e31229";
const ORG_PUB = "org_2f65ddde1f5b4e938c0b80e030e31229";
const PARENT_HEX = "11111111-1111-1111-1111-111111111111";
const PARENT_PUB = "org_11111111111111111111111111111111";

function org(parentOrgId: string | null): Organization {
  return { id: ORG_HEX, name: "O", slug: "o", slugLower: "o", status: "active", parentOrgId, createdAt: new Date(), updatedAt: new Date() };
}
function req(orgId: string): Request {
  return new Request("https://m/v1/internal/membership/organizations/billing-parent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgId }),
  });
}
function depsFor(value: MembershipResult<Organization>) {
  return { repo: { getOrganizationById: async (): Promise<MembershipResult<Organization>> => value } };
}

describe("handleResolveBillingParent", () => {
  it("returns self for a standalone org", async () => {
    const res = await handleResolveBillingParent(req(ORG_PUB), env, "req", depsFor({ ok: true, value: org(null) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { billingOrgId: string; isChild: boolean } };
    expect(body.data.billingOrgId).toBe(ORG_PUB);
    expect(body.data.isChild).toBe(false);
  });

  it("returns the parent for a child org", async () => {
    const res = await handleResolveBillingParent(req(ORG_PUB), env, "req", depsFor({ ok: true, value: org(PARENT_HEX) }));
    const body = (await res.json()) as { data: { billingOrgId: string; isChild: boolean } };
    expect(body.data.billingOrgId).toBe(PARENT_PUB);
    expect(body.data.isChild).toBe(true);
  });

  it("404 when the org is not found", async () => {
    const res = await handleResolveBillingParent(req(ORG_PUB), env, "req", depsFor({ ok: false, error: { kind: "not_found" } }));
    expect(res.status).toBe(404);
  });

  it("400 on a malformed orgId", async () => {
    const res = await handleResolveBillingParent(req("not-an-org"), env, "req", depsFor({ ok: false, error: { kind: "not_found" } }));
    expect(res.status).toBe(400);
  });
});
