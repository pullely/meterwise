// Edge-side idempotency-key validation tests (Task 0094).
//
// Asserts the validation gate added in `apps/api-edge/src/idempotency.ts`:
//   - valid `Idempotency-Key` on POST → forwarded downstream (2xx flow)
//   - missing `Idempotency-Key` on POST → forwarded (header is optional)
//   - malformed `Idempotency-Key` on POST → 400 `validation_failed` at the edge,
//     downstream worker NEVER called
//   - safe GET with malformed header → not rejected for the malformed reason
//     (the edge has no idempotency semantics on reads)
//
// Two facades are covered to satisfy the Task 0094 acceptance criterion:
//   - auth-facade.handleAuthRoute (POST /v1/auth/login/start, GET /v1/auth/session)
//   - org-facade.handleOrgRoute   (POST /v1/organizations)

import { handleAuthRoute } from "@api-edge/auth-facade";
import { handleOrgRoute } from "@api-edge/org-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(
  response: Response = Response.json({
    data: {},
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

function createSessionFetcher(userId: string): { fetcher: Fetcher; calls: FetchCall[] } {
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
      if (url.includes("/v1/auth/resolve")) {
        return Promise.resolve(
          Response.json({
            data: {
              actor: { actorType: "user", actorId: userId, email: "user@test.com" },
              session: {
                id: "ses_abc",
                expiresAt: "2026-12-01T00:00:00Z",
                createdAt: "2026-01-01T00:00:00Z",
              },
              user: { id: userId, email: "user@test.com", displayName: "Test" },
            },
            meta: { requestId: "req_inner", cursor: null },
          }),
        );
      }
      return Promise.resolve(
        Response.json({ data: {}, meta: { requestId: "req_test", cursor: null } }),
      );
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

const VALID_KEY = "550e8400-e29b-41d4-a716-446655440000";
const MALFORMED_KEY_TOO_LONG = "a".repeat(256);
// Note: the `illegal_characters` reason is exercised by the contract-level unit test
// (`tests/contracts/src/idempotency.test.ts`). At the edge layer we can't construct a
// Request with a literal CR/LF in a header — the Web Headers constructor rejects it
// before it reaches our validator — so edge coverage here uses `too_long` and `empty`,
// which both round-trip cleanly through Request and Headers.

describe("api-edge idempotency-key validation gate", () => {
  describe("auth-facade (POST /v1/auth/login/start)", () => {
    it("forwards request when Idempotency-Key is valid", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": VALID_KEY,
        },
        body: JSON.stringify({ email: "user@test.com" }),
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      const forwarded = new Headers(calls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("idempotency-key")).toBe(VALID_KEY);
    });

    it("forwards request when Idempotency-Key is absent (header is optional)", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "user@test.com" }),
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
    });

    it("rejects with 400 validation_failed when Idempotency-Key is too long", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": MALFORMED_KEY_TOO_LONG,
        },
        body: JSON.stringify({ email: "user@test.com" }),
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; message: string; details?: { reason?: string; header?: string } };
      };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.message).toContain("Idempotency-Key");
      expect(body.error.details?.header).toBe("Idempotency-Key");
      expect(body.error.details?.reason).toBe("too_long");
      // critically, downstream worker MUST NOT be invoked
      expect(calls).toHaveLength(0);
    });

    it("rejects with 400 when Idempotency-Key is empty/whitespace", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/login/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "   ",
        },
        body: JSON.stringify({ email: "user@test.com" }),
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/auth/login/start",
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; details?: { reason?: string } };
      };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details?.reason).toBe("empty");
      expect(calls).toHaveLength(0);
    });

    it("does NOT reject GET requests for a malformed Idempotency-Key (reads have no idempotency semantics)", async () => {
      const { fetcher, calls } = createFakeFetcher();
      const request = new Request("https://api.example.com/v1/auth/session", {
        method: "GET",
        headers: {
          authorization: "Bearer sps_ses_abc.secret",
          "idempotency-key": MALFORMED_KEY_TOO_LONG,
        },
      });

      const response = await handleAuthRoute(
        request,
        { IDENTITY_WORKER: fetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/auth/session",
      );

      // Forwarded — not rejected at the edge for the idempotency reason.
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
    });
  });

  describe("org-facade (POST /v1/organizations)", () => {
    it("forwards request when Idempotency-Key is valid", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "POST",
        headers: {
          authorization: "Bearer sps_ses_abc.secret",
          "content-type": "application/json",
          "idempotency-key": VALID_KEY,
        },
        body: JSON.stringify({ name: "Acme" }),
      });

      const response = await handleOrgRoute(
        request,
        {
          IDENTITY_WORKER: identityFetcher,
          MEMBERSHIP_WORKER: membershipFetcher,
          ENVIRONMENT: "test",
        },
        "req_test",
        "/v1/organizations",
      );

      expect(response.status).toBe(200);
      expect(membershipCalls).toHaveLength(1);
      const forwarded = new Headers(membershipCalls[0]!.init.headers as HeadersInit);
      expect(forwarded.get("idempotency-key")).toBe(VALID_KEY);
    });

    it("forwards request when Idempotency-Key is absent", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "POST",
        headers: {
          authorization: "Bearer sps_ses_abc.secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Acme" }),
      });

      const response = await handleOrgRoute(
        request,
        {
          IDENTITY_WORKER: identityFetcher,
          MEMBERSHIP_WORKER: membershipFetcher,
          ENVIRONMENT: "test",
        },
        "req_test",
        "/v1/organizations",
      );

      expect(response.status).toBe(200);
      expect(membershipCalls).toHaveLength(1);
    });

    it("rejects with 400 validation_failed when Idempotency-Key is malformed (too long)", async () => {
      const { fetcher: identityFetcher, calls: identityCalls } = createSessionFetcher(
        "usr_abc123",
      );
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "POST",
        headers: {
          authorization: "Bearer sps_ses_abc.secret",
          "content-type": "application/json",
          "idempotency-key": MALFORMED_KEY_TOO_LONG,
        },
        body: JSON.stringify({ name: "Acme" }),
      });

      const response = await handleOrgRoute(
        request,
        {
          IDENTITY_WORKER: identityFetcher,
          MEMBERSHIP_WORKER: membershipFetcher,
          ENVIRONMENT: "test",
        },
        "req_test",
        "/v1/organizations",
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        error: { code: string; details?: { reason?: string; header?: string } };
      };
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.details?.header).toBe("Idempotency-Key");
      expect(body.error.details?.reason).toBe("too_long");
      // gate must run BEFORE both identity-resolve and the downstream membership fetch
      expect(identityCalls).toHaveLength(0);
      expect(membershipCalls).toHaveLength(0);
    });

    it("does NOT reject GET /v1/organizations with malformed Idempotency-Key", async () => {
      const { fetcher: identityFetcher } = createSessionFetcher("usr_abc123");
      const { fetcher: membershipFetcher, calls: membershipCalls } = createFakeFetcher();

      const request = new Request("https://api.example.com/v1/organizations", {
        method: "GET",
        headers: {
          authorization: "Bearer sps_ses_abc.secret",
          "idempotency-key": MALFORMED_KEY_TOO_LONG,
        },
      });

      const response = await handleOrgRoute(
        request,
        {
          IDENTITY_WORKER: identityFetcher,
          MEMBERSHIP_WORKER: membershipFetcher,
          ENVIRONMENT: "test",
        },
        "req_test",
        "/v1/organizations",
      );

      // GET passes through to membership worker; never 400 for the idempotency reason.
      expect(response.status).toBe(200);
      expect(membershipCalls).toHaveLength(1);
    });
  });
});
