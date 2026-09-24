import worker from "@api-edge/index";
import { isSoloMode, isSoloSuppressed } from "@api-edge/solo-mode";

// ── Fake service bindings (mirrors the other facade tests) ──────────────

function ok200(body: unknown = { data: {}, meta: { requestId: "req_inner", cursor: null } }): Fetcher {
  return {
    fetch(): Promise<Response> {
      return Promise.resolve(Response.json(body));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

// IDENTITY_WORKER stub that resolves any bearer token to a user actor, so the
// baseline (SOLO_MODE off) pass-through paths reach their downstream worker.
function sessionFetcher(userId = "usr_abc123"): Fetcher {
  return {
    fetch(input: string | Request | URL): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/auth/resolve")) {
        return Promise.resolve(
          Response.json({
            data: {
              actor: { actorType: "user", actorId: userId, email: "user@test.com" },
              session: { id: "ses_abc" },
              user: { id: userId, email: "user@test.com", displayName: "Test" },
            },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: {}, meta: { requestId: "req_inner", cursor: null } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function makeEnv(soloMode: boolean) {
  return {
    ENVIRONMENT: "test",
    ...(soloMode ? { SOLO_MODE: "true" } : {}),
    IDENTITY_WORKER: sessionFetcher(),
    MEMBERSHIP_WORKER: ok200(),
    PROJECTS_WORKER: ok200(),
    EVENTS_WORKER: ok200(),
    CONFIG_WORKER: ok200(),
    WEBHOOKS_WORKER: ok200(),
    METERING_WORKER: ok200(),
    BILLING_WORKER: ok200(),
    NOTIFICATIONS_WORKER: ok200(),
    INTEGRATIONS_WORKER: ok200(),
  };
}

function req(path: string, method = "GET"): Request {
  return new Request(`https://api.test${path}`, {
    method,
    headers: { authorization: "Bearer tok_test", "x-request-id": "req_test" },
  });
}

// ── Pure predicate: isSoloMode ──────────────────────────────────────────

describe("isSoloMode", () => {
  it('is true only for the exact string "true"', () => {
    expect(isSoloMode({ SOLO_MODE: "true" } as never)).toBe(true);
    expect(isSoloMode({} as never)).toBe(false);
    expect(isSoloMode({ SOLO_MODE: "false" } as never)).toBe(false);
    expect(isSoloMode({ SOLO_MODE: "1" } as never)).toBe(false);
    expect(isSoloMode({ SOLO_MODE: "TRUE" } as never)).toBe(false);
  });
});

// ── Pure predicate: isSoloSuppressed (the suppression policy) ────────────

describe("isSoloSuppressed — suppressed surfaces", () => {
  const suppressed: Array<[string, string]> = [
    ["/v1/organizations/org_x/members", "GET"],
    ["/v1/organizations/org_x/members/mbr_y", "DELETE"],
    ["/v1/organizations/org_x/invitations", "POST"],
    ["/v1/organizations/org_x/invitations/inv_y", "DELETE"],
    ["/v1/organizations/org_x/invitations/accept", "POST"],
    ["/v1/organizations/org_x/api-keys", "POST"],
    ["/v1/organizations/org_x/api-keys/key_y", "DELETE"],
    ["/v1/organizations/org_x/projects", "GET"],
    ["/v1/organizations/org_x/projects/prj_y", "GET"],
    ["/v1/organizations/org_x/projects/prj_y/environments", "GET"],
    ["/v1/organizations/org_x/usage", "GET"],
    ["/v1/organizations/org_x/usage/summary", "GET"],
    ["/v1/organizations/org_x/quotas/check", "POST"],
    ["/v1/organizations/org_x/webhooks/ep_y", "GET"],
    ["/v1/organizations/org_x/integrations", "GET"],
    ["/v1/organizations/org_x/integrations/github", "GET"],
    ["/ingress/github/webhook", "POST"],
  ];
  it.each(suppressed)("suppresses %s %s", (path, method) => {
    expect(isSoloSuppressed(path, method)).toBe(true);
  });
});

describe("isSoloSuppressed — kept (single-user) surfaces", () => {
  const kept: Array<[string, string]> = [
    ["/v1/organizations", "GET"], // list (resolve the personal org)
    ["/v1/organizations/org_x", "GET"], // read the personal org
    // Bootstrapping the personal org. The one-org rule is enforced in
    // membership-worker (which can count the account's orgs); suppressing the
    // verb here also blocked the FIRST org, stranding any account whose
    // login-time auto-provisioning didn't land.
    ["/v1/organizations", "POST"],
    ["/v1/auth/session", "GET"],
    ["/v1/auth/login/start", "POST"],
    ["/v1/auth/profile", "PATCH"],
    ["/v1/organizations/org_x/billing/checkout", "POST"],
    ["/v1/organizations/org_x/billing/portal", "POST"],
    ["/v1/billing/webhooks/polar", "POST"], // provider webhook ≠ outbound webhooks
    ["/v1/organizations/org_x/config/feature-flags", "GET"],
    ["/v1/organizations/org_x/config/settings", "GET"],
    ["/v1/organizations/org_x/audit", "GET"], // silent audit kept
    ["/v1/notifications/preferences", "GET"],
    ["/health", "GET"],
  ];
  it.each(kept)("keeps %s %s", (path, method) => {
    expect(isSoloSuppressed(path, method)).toBe(false);
  });
});

// ── Integration: the switch through the worker entrypoint ───────────────

describe("worker.fetch with SOLO_MODE on", () => {
  const env = makeEnv(true);

  it.each([
    "/v1/organizations/org_x/members",
    "/v1/organizations/org_x/projects",
    "/v1/organizations/org_x/usage",
    "/v1/organizations/org_x/integrations",
    "/v1/organizations/org_x/webhooks/ep_1",
  ])("404s suppressed route %s", async (path) => {
    const res = await worker.fetch(req(path), env as never);
    expect(res.status).toBe(404);
  });

  it("keeps org bootstrap reachable (POST /v1/organizations)", async () => {
    // The Solo one-org rule is membership-worker's call — the edge must let the
    // account's FIRST org through, or an account whose login-time provisioning
    // no-oped can never obtain one (the console's onboarding fallback 404s).
    const res = await worker.fetch(req("/v1/organizations", "POST"), env as never);
    expect(res.status).not.toBe(404);
  });

  it("keeps the personal-org list reachable (GET /v1/organizations)", async () => {
    const res = await worker.fetch(req("/v1/organizations"), env as never);
    expect(res.status).not.toBe(404);
  });

  it.each([
    "/health",
    "/v1/organizations/org_x/billing/summary",
    "/v1/organizations/org_x/config/feature-flags",
  ])("keeps single-user surface %s reachable", async (path) => {
    const res = await worker.fetch(req(path), env as never);
    expect(res.status).not.toBe(404);
  });
});

describe("worker.fetch with SOLO_MODE off (baseline restored)", () => {
  const env = makeEnv(false);

  it.each([
    "/v1/organizations/org_x/members",
    "/v1/organizations/org_x/projects",
    "/v1/organizations/org_x/usage",
    "/v1/organizations/org_x/integrations",
  ])("does NOT suppress %s (reaches its facade)", async (path) => {
    const res = await worker.fetch(req(path), env as never);
    expect(res.status).not.toBe(404);
  });

  it("allows creating an org (POST /v1/organizations) in baseline", async () => {
    const res = await worker.fetch(req("/v1/organizations", "POST"), env as never);
    expect(res.status).not.toBe(404);
  });
});
