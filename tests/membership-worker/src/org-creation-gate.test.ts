import { handleCreateOrganization } from "@membership-worker/handlers/create-organization";
import { decideOrgCreationGate } from "@membership-worker/billing-client";
import type { Env } from "@membership-worker/env";
import type { ActorContext } from "@membership-worker/router";
import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";
import type { Organization, MembershipResult, BootstrapOrganizationInput } from "@saas/db/membership";

const ACTOR: ActorContext = { subjectId: "usr_1", subjectType: "user" };
const env = { ENVIRONMENT: "test" } as Env;

function allowed(
  key: string,
  valueType: "boolean" | "quantity",
  limitValue: number | null,
): CheckBillingEntitlementResponse {
  return { allowed: true, orgId: "org_x", entitlementKey: key, valueType, limitValue, source: "plan", subscriptionId: null };
}
function denied(key: string, reason: "disabled" | "not_configured"): CheckBillingEntitlementResponse {
  return { allowed: false, orgId: "org_x", entitlementKey: key, reason };
}

const MULTI = "feature.multi_org";
const LIMIT = "limit.organizations";

describe("decideOrgCreationGate", () => {
  it("denies when multi_org is disabled", () => {
    const g = decideOrgCreationGate(denied(MULTI, "disabled"), allowed(LIMIT, "quantity", 1), 1);
    expect(g).toMatchObject({ kind: "deny", reason: "disabled" });
  });
  it("denies when multi_org is not configured", () => {
    const g = decideOrgCreationGate(denied(MULTI, "not_configured"), allowed(LIMIT, "quantity", 1), 1);
    expect(g).toMatchObject({ kind: "deny", reason: "not_configured" });
  });
  it("allows when enabled and unlimited", () => {
    const g = decideOrgCreationGate(allowed(MULTI, "boolean", null), allowed(LIMIT, "quantity", null), 99);
    expect(g.kind).toBe("allow");
  });
  it("allows when under the org limit", () => {
    const g = decideOrgCreationGate(allowed(MULTI, "boolean", null), allowed(LIMIT, "quantity", 5), 1);
    expect(g.kind).toBe("allow");
  });
  it("denies limit_reached at/over the org limit", () => {
    const g = decideOrgCreationGate(allowed(MULTI, "boolean", null), allowed(LIMIT, "quantity", 5), 5);
    expect(g).toMatchObject({ kind: "deny", reason: "limit_reached" });
  });
  it("denies malformed when the limit is not a quantity", () => {
    const g = decideOrgCreationGate(allowed(MULTI, "boolean", null), allowed(LIMIT, "boolean", null), 1);
    expect(g).toMatchObject({ kind: "deny", reason: "malformed_limit" });
  });
});

function org(id: string, createdAt: string): Organization {
  return {
    id,
    name: "Acme",
    slug: "acme",
    slugLower: "acme",
    status: "active",
    parentOrgId: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function makeDeps(opts: {
  existing: Organization[];
  entitlements: Record<string, CheckBillingEntitlementResponse>;
}) {
  return {
    repo: {
      bootstrapOrganization: async () => ({
        ok: true as const,
        value: {
          org: org("00000000-0000-0000-0000-0000000000aa", "2026-06-01T00:00:00Z"),
          member: { id: "m", orgId: "o", subjectId: "usr_1", subjectType: "user", status: "active", createdAt: new Date(), updatedAt: new Date() },
          roleAssignment: { id: "r", orgId: "o", subjectId: "usr_1", subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: new Date(), revokedAt: null },
        },
      }),
    },
    listOrgsForSubject: async (): Promise<MembershipResult<Organization[]>> => ({ ok: true, value: opts.existing }),
    checkEntitlement: async (_b: Fetcher, _o: string, key: string) => ({
      kind: "decision" as const,
      decision: opts.entitlements[key]!,
    }),
  };
}

function req(): Request {
  return new Request("https://membership/v1/organizations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "New Org", slug: "new-org" }),
  });
}

describe("handleCreateOrganization — MO2 additional-org gate", () => {
  it("allows the first/bootstrap org (no existing orgs)", async () => {
    const deps = makeDeps({ existing: [], entitlements: {} });
    const res = await handleCreateOrganization(req(), env, "req_t", ACTOR, deps);
    expect(res.status).toBe(201);
  });

  it("blocks a second org on a non-multi-org plan with 412 (disabled)", async () => {
    const deps = makeDeps({
      existing: [org("00000000-0000-0000-0000-0000000000a1", "2026-01-01T00:00:00Z")],
      entitlements: { [MULTI]: denied(MULTI, "disabled"), [LIMIT]: allowed(LIMIT, "quantity", 1) },
    });
    const res = await handleCreateOrganization(req(), env, "req_t", ACTOR, deps);
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("precondition_failed");
    expect(JSON.stringify(body)).toContain("disabled");
  });

  it("allows an additional org on a multi-org plan under the limit", async () => {
    const deps = makeDeps({
      existing: [org("00000000-0000-0000-0000-0000000000a1", "2026-01-01T00:00:00Z")],
      entitlements: { [MULTI]: allowed(MULTI, "boolean", null), [LIMIT]: allowed(LIMIT, "quantity", 5) },
    });
    const res = await handleCreateOrganization(req(), env, "req_t", ACTOR, deps);
    expect(res.status).toBe(201);
  });

  it("blocks at the org limit with 412 (limit_reached)", async () => {
    const existing = Array.from({ length: 5 }, (_, i) =>
      org(`00000000-0000-0000-0000-00000000000${i}`, `2026-0${i + 1}-01T00:00:00Z`),
    );
    const deps = makeDeps({
      existing,
      entitlements: { [MULTI]: allowed(MULTI, "boolean", null), [LIMIT]: allowed(LIMIT, "quantity", 5) },
    });
    const res = await handleCreateOrganization(req(), env, "req_t", ACTOR, deps);
    expect(res.status).toBe(412);
    expect(JSON.stringify(await res.json())).toContain("limit_reached");
  });

  // M0 / Solo profile: the account is capped at its one personal org. The
  // BOOTSTRAP org must stay creatable — that is what login-time
  // auto-provisioning (and the console's onboarding fallback when it didn't
  // land) uses; blanket-blocking the verb at the edge stranded those accounts.
  describe("with SOLO_MODE on", () => {
    const soloEnv = { ENVIRONMENT: "test", SOLO_MODE: "true" } as Env;

    it("still allows the first/bootstrap org", async () => {
      const deps = makeDeps({ existing: [], entitlements: {} });
      const res = await handleCreateOrganization(req(), soloEnv, "req_t", ACTOR, deps);
      expect(res.status).toBe(201);
    });

    it("blocks a second org with 403 even on a multi-org plan", async () => {
      const deps = makeDeps({
        existing: [org("00000000-0000-0000-0000-0000000000a1", "2026-01-01T00:00:00Z")],
        entitlements: { [MULTI]: allowed(MULTI, "boolean", null), [LIMIT]: allowed(LIMIT, "quantity", 5) },
      });
      const res = await handleCreateOrganization(req(), soloEnv, "req_t", ACTOR, deps);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("forbidden");
      expect(JSON.stringify(body)).toContain("solo_profile");
    });
  });

  it("links an allowed additional org as a child and fans out the parent plan (MO3)", async () => {
    const PARENT_HEX = "00000000-0000-0000-0000-0000000000a1";
    let capturedParentOrgId: string | null | undefined;
    const fanOutCalls: Array<{ parent: string; child: string }> = [];
    const deps = {
      repo: {
        bootstrapOrganization: async (input: BootstrapOrganizationInput) => {
          capturedParentOrgId = input.org.parentOrgId;
          return {
            ok: true as const,
            value: {
              org: org("00000000-0000-0000-0000-0000000000bb", "2026-06-01T00:00:00Z"),
              member: { id: "m", orgId: "o", subjectId: "usr_1", subjectType: "user", status: "active", createdAt: new Date(), updatedAt: new Date() },
              roleAssignment: { id: "r", orgId: "o", subjectId: "usr_1", subjectType: "user", role: "owner", scopeKind: "organization", scopeRef: null, createdAt: new Date(), revokedAt: null },
            },
          };
        },
      },
      listOrgsForSubject: async () => ({ ok: true as const, value: [org(PARENT_HEX, "2026-01-01T00:00:00Z")] }),
      checkEntitlement: async (_b: Fetcher, _o: string, key: string) => ({
        kind: "decision" as const,
        decision: key === MULTI ? allowed(MULTI, "boolean", null) : allowed(LIMIT, "quantity", 5),
      }),
      fanOut: async (parent: string, child: string) => {
        fanOutCalls.push({ parent, child });
        return { kind: "ok" as const };
      },
    };
    const res = await handleCreateOrganization(req(), env, "req_t", ACTOR, deps);
    expect(res.status).toBe(201);
    expect(capturedParentOrgId).toBe(PARENT_HEX);
    expect(fanOutCalls).toHaveLength(1);
    expect(fanOutCalls[0]!.parent).toBe("org_000000000000000000000000000000a1");
    expect(fanOutCalls[0]!.child).toBe("org_000000000000000000000000000000bb");
  });
});
