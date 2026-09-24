import { isBillingRoute, handleBillingRoute } from "@api-edge/billing-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({
    data: { plans: [] },
    meta: { requestId: "req_test", cursor: null },
  }),
): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(response.clone());
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createThrowingFetcher(): Fetcher {
  return {
    fetch(): Promise<Response> {
      return Promise.reject(new Error("connection refused"));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createSessionFetcher(userId: string): { fetcher: Fetcher } {
  const fetcher = {
    fetch(input: string | Request | URL): Promise<Response> {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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
      return Promise.resolve(
        Response.json({
          data: { plans: [] },
          meta: { requestId: "req_test", cursor: null },
        }),
      );
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher };
}

function createEnv(overrides?: Record<string, unknown>) {
  const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
  const { fetcher: billingFetcher } = createFakeFetcher();
  return {
    IDENTITY_WORKER: identityFetcher,
    BILLING_WORKER: billingFetcher,
    ENVIRONMENT: "test",
    ...overrides,
  };
}

describe("api-edge billing facade", () => {
  describe("isBillingRoute", () => {
    it("matches plans", () => {
      expect(
        isBillingRoute("/v1/organizations/org_abc123def456/billing/plans"),
      ).toBe(true);
    });
    it("matches customer", () => {
      expect(
        isBillingRoute("/v1/organizations/org_abc/billing/customer"),
      ).toBe(true);
    });
    it("matches summary", () => {
      expect(
        isBillingRoute("/v1/organizations/org_abc/billing/summary"),
      ).toBe(true);
    });
    it("matches invoices", () => {
      expect(
        isBillingRoute("/v1/organizations/org_abc/billing/invoices"),
      ).toBe(true);
    });
    it("matches entitlements", () => {
      expect(
        isBillingRoute("/v1/organizations/org_abc/billing/entitlements"),
      ).toBe(true);
    });
    it("does not match unknown billing subpath", () => {
      expect(
        isBillingRoute("/v1/organizations/org_abc/billing/unknown"),
      ).toBe(false);
    });
    it("does not match mutation-style routes", () => {
      expect(
        isBillingRoute("/v1/organizations/org_abc/billing/invoices/inv_abc"),
      ).toBe(false);
    });
    it("does not match metering routes", () => {
      expect(
        isBillingRoute("/v1/organizations/org_abc/usage"),
      ).toBe(false);
    });
    it("does not expose the private internal entitlement-check route", () => {
      // Task 0078 introduced POST /v1/internal/billing/entitlements/check on
      // billing-worker as a private service-binding route. api-edge MUST NOT
      // route this — public traffic must never reach it.
      expect(
        isBillingRoute("/v1/internal/billing/entitlements/check"),
      ).toBe(false);
      expect(
        isBillingRoute("/v1/organizations/org_abc/billing/entitlements/check"),
      ).toBe(false);
      expect(
        isBillingRoute("/v1/internal/billing/entitlements"),
      ).toBe(false);
    });
    it("public billing facade matches the read routes plus checkout/portal (BP2)", () => {
      // Documents the exact public surface — guards against accidental
      // expansion of the facade. Any new public billing route should require
      // a deliberate change to this list. checkout/portal are the deliberate
      // BP2 additions (POST, provider hand-off).
      const allowed = [
        "/v1/organizations/org_abc/billing/plans",
        "/v1/organizations/org_abc/billing/customer",
        "/v1/organizations/org_abc/billing/summary",
        "/v1/organizations/org_abc/billing/invoices",
        "/v1/organizations/org_abc/billing/entitlements",
        "/v1/organizations/org_abc/billing/checkout",
        "/v1/organizations/org_abc/billing/portal",
      ];
      for (const p of allowed) {
        expect(isBillingRoute(p)).toBe(true);
      }
      const denied = [
        "/v1/organizations/org_abc/billing",
        "/v1/organizations/org_abc/billing/subscriptions",
        "/v1/internal/billing/entitlements/check",
        "/v1/internal/billing",
        "/v1/billing/entitlements/check",
      ];
      for (const p of denied) {
        expect(isBillingRoute(p)).toBe(false);
      }
    });
  });

  describe("handleBillingRoute", () => {
    it("returns 405 for GET on a write route (checkout)", async () => {
      const env = createEnv();
      const req = new Request(
        "https://api-edge/v1/organizations/org_abc/billing/checkout",
        { method: "GET", headers: { authorization: "Bearer tok_test" } },
      );
      const res = await handleBillingRoute(
        req,
        env as never,
        "req_test",
        "/v1/organizations/org_abc/billing/checkout",
      );
      expect(res.status).toBe(405);
    });

    it("returns 405 for POST", async () => {
      const env = createEnv();
      const req = new Request(
        "https://api-edge/v1/organizations/org_abc/billing/plans",
        {
          method: "POST",
          headers: { authorization: "Bearer tok_test" },
        },
      );
      const res = await handleBillingRoute(
        req,
        env as never,
        "req_test",
        "/v1/organizations/org_abc/billing/plans",
      );
      expect(res.status).toBe(405);
    });

    it("returns 503 when IDENTITY_WORKER missing", async () => {
      const env = createEnv({ IDENTITY_WORKER: undefined });
      const req = new Request(
        "https://api-edge/v1/organizations/org_abc/billing/plans",
        {
          method: "GET",
          headers: { authorization: "Bearer tok_test" },
        },
      );
      const res = await handleBillingRoute(
        req,
        env as never,
        "req_test",
        "/v1/organizations/org_abc/billing/plans",
      );
      expect(res.status).toBe(503);
    });

    it("returns 503 when BILLING_WORKER missing", async () => {
      const env = createEnv({ BILLING_WORKER: undefined });
      const req = new Request(
        "https://api-edge/v1/organizations/org_abc/billing/plans",
        {
          method: "GET",
          headers: { authorization: "Bearer tok_test" },
        },
      );
      const res = await handleBillingRoute(
        req,
        env as never,
        "req_test",
        "/v1/organizations/org_abc/billing/plans",
      );
      expect(res.status).toBe(503);
    });

    it("returns 401 when authorization header is missing", async () => {
      const env = createEnv();
      const req = new Request(
        "https://api-edge/v1/organizations/org_abc/billing/plans",
        { method: "GET" },
      );
      const res = await handleBillingRoute(
        req,
        env as never,
        "req_test",
        "/v1/organizations/org_abc/billing/plans",
      );
      expect(res.status).toBe(401);
    });

    it("forwards GET to BILLING_WORKER with actor headers and search", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const billingResponse = Response.json({
        data: { plans: [] },
        meta: { requestId: "req_test", cursor: null },
      });
      const { fetcher: billingFetcher, calls: billingCalls } =
        createFakeFetcher(billingResponse);
      const env = createEnv({
        IDENTITY_WORKER: identityFetcher,
        BILLING_WORKER: billingFetcher,
      });
      const req = new Request(
        "https://api-edge/v1/organizations/org_abc/billing/invoices?limit=10",
        {
          method: "GET",
          headers: {
            authorization: "Bearer tok_test",
            "x-request-id": "req_fwd",
          },
        },
      );
      const res = await handleBillingRoute(
        req,
        env as never,
        "req_fwd",
        "/v1/organizations/org_abc/billing/invoices",
      );
      expect(res.status).toBe(200);
      expect(billingCalls.length).toBe(1);
      expect(billingCalls[0]!.url).toContain(
        "/v1/organizations/org_abc/billing/invoices?limit=10",
      );
      const fwdHeaders = billingCalls[0]!.init.headers as Headers;
      expect(fwdHeaders.get("x-actor-subject-id")).toBe("usr_test");
      expect(fwdHeaders.get("x-actor-subject-type")).toBe("user");
      expect(fwdHeaders.get("x-request-id")).toBe("req_fwd");
    });

    it("returns 503 when BILLING_WORKER fetch throws", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_test");
      const env = createEnv({
        IDENTITY_WORKER: identityFetcher,
        BILLING_WORKER: createThrowingFetcher(),
      });
      const req = new Request(
        "https://api-edge/v1/organizations/org_abc/billing/plans",
        {
          method: "GET",
          headers: { authorization: "Bearer tok_test" },
        },
      );
      const res = await handleBillingRoute(
        req,
        env as never,
        "req_test",
        "/v1/organizations/org_abc/billing/plans",
      );
      expect(res.status).toBe(503);
    });
  });
});
