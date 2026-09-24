import { isOrgRoute, handleOrgRoute } from "@api-edge/org-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({ data: {}, meta: { requestId: "req_test", cursor: null } }),
): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(response.clone());
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function createSessionFetcher(userId: string): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      if (url.includes("/v1/auth/resolve")) {
        return Promise.resolve(
          Response.json({
            data: {
              actor: { actorType: "user", actorId: userId, email: "user@test.com" },
              session: { id: "ses_abc", expiresAt: "2026-12-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
              user: { id: userId, email: "user@test.com", displayName: "Test" },
            },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: {}, meta: { requestId: "req_test", cursor: null } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

describe("api-edge api-key routes", () => {
  describe("isOrgRoute", () => {
    it("matches /v1/organizations/{id}/api-keys", () => {
      expect(isOrgRoute("/v1/organizations/org_abc123/api-keys")).toBe(true);
    });

    it("matches /v1/organizations/{id}/api-keys/{keyId}", () => {
      expect(isOrgRoute("/v1/organizations/org_abc123/api-keys/key_xyz")).toBe(true);
    });
  });

  describe("routing api-key requests to IDENTITY_WORKER", () => {
    it("forwards POST /v1/organizations/{id}/api-keys to IDENTITY_WORKER", async () => {
      const { fetcher: identityFetcher, calls: identityCalls } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/api-keys", {
        method: "POST",
        headers: { authorization: "Bearer sps_ses_abc.secret", "content-type": "application/json" },
        body: JSON.stringify({ label: "test", role: "admin" }),
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/api-keys",
      );

      // Session resolve + forwarded request = 2 calls to IDENTITY_WORKER
      expect(identityCalls).toHaveLength(2);
      expect(identityCalls[0]!.url).toContain("/v1/auth/resolve");
      expect(identityCalls[1]!.url).toContain("/v1/organizations/org_abc/api-keys");

      // MEMBERSHIP_WORKER should NOT be called
      expect(membershipCalls).toHaveLength(0);
    });

    it("forwards GET /v1/organizations/{id}/api-keys to IDENTITY_WORKER", async () => {
      const { fetcher: identityFetcher, calls: identityCalls } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/api-keys", {
        method: "GET",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/api-keys",
      );

      expect(identityCalls).toHaveLength(2);
      expect(identityCalls[1]!.url).toContain("/v1/organizations/org_abc/api-keys");
      expect(membershipCalls).toHaveLength(0);
    });

    it("forwards DELETE /v1/organizations/{id}/api-keys/{keyId} to IDENTITY_WORKER", async () => {
      const { fetcher: identityFetcher, calls: identityCalls } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/api-keys/key_xyz", {
        method: "DELETE",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/api-keys/key_xyz",
      );

      expect(identityCalls).toHaveLength(2);
      expect(identityCalls[1]!.url).toContain("/v1/organizations/org_abc/api-keys/key_xyz");
      expect(membershipCalls).toHaveLength(0);
    });
  });

  describe("method validation", () => {
    it("returns 405 for PUT on /v1/organizations/{id}/api-keys", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/api-keys", {
        method: "PUT",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/api-keys",
      );

      expect(response.status).toBe(405);
      const json = await response.json() as any;
      expect(json.error.code).toBe("unsupported");
    });

    it("returns 405 for PATCH on /v1/organizations/{id}/api-keys/{keyId}", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations/org_abc/api-keys/key_xyz", {
        method: "PATCH",
        headers: { authorization: "Bearer sps_ses_abc.secret" },
      });

      const response = await handleOrgRoute(
        request,
        { IDENTITY_WORKER: identityFetcher, MEMBERSHIP_WORKER: membershipFetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_abc/api-keys/key_xyz",
      );

      expect(response.status).toBe(405);
      const json = await response.json() as any;
      expect(json.error.code).toBe("unsupported");
    });
  });
});
