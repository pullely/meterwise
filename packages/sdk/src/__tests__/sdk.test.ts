import { describe, expect, it, vi } from "vitest";

import { Meterwise } from "../index.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PreconditionFailedError,
  RateLimitError,
  MeterwiseError,
  UnauthenticatedError,
  UnsupportedError,
  ValidationError,
} from "../errors.js";
import { generateRequestId, Transport } from "../transport.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function captureFetch(response: Response): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fn: typeof fetch = vi.fn(async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response.clone();
  });
  return { fetch: fn, calls };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

const SUCCESS_LIST = {
  data: { organizations: [{ id: "org_1", name: "Acme", slug: "acme", createdAt: "2025-01-01T00:00:00Z" }] },
  meta: { requestId: "req_server_1", cursor: null },
};

describe("Transport — success path", () => {
  it("unwraps the data envelope on GET", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(SUCCESS_LIST));
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });

    const result = await client.organizations.list();

    expect(result).toEqual(SUCCESS_LIST.data);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("strips trailing slash from baseUrl", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(SUCCESS_LIST));
    const client = new Meterwise({ baseUrl: "https://api.test/", fetch });
    await client.organizations.list();
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations");
  });

  it("returns 204 as undefined", async () => {
    const { fetch } = captureFetch(new Response(null, { status: 204 }));
    const transport = new Transport({ baseUrl: "https://api.test", fetch });
    const result = await transport.request<void>({ method: "DELETE", path: "/v1/x" });
    expect(result).toBeUndefined();
  });

  it("encodes path parameters", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { project: {} }, meta: { requestId: "req_x", cursor: null } }),
    );
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    await client.projects.get("org/with slash", "proj");
    expect(calls[0]!.url).toContain("org%2Fwith%20slash");
  });
});

describe("Transport — auth", () => {
  it("attaches bearer token", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(SUCCESS_LIST));
    const client = new Meterwise({
      baseUrl: "https://api.test",
      auth: { kind: "bearer", token: "test-token" },
      fetch,
    });
    await client.organizations.list();
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer test-token");
  });

  it("attaches session cookie", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(SUCCESS_LIST));
    const client = new Meterwise({
      baseUrl: "https://api.test",
      auth: { kind: "session", cookie: "sb_session=abc" },
      fetch,
    });
    await client.organizations.list();
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("cookie")).toBe("sb_session=abc");
  });
});

describe("Transport — request id", () => {
  it("auto-generates a req_-prefixed id when caller omits", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(SUCCESS_LIST));
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    await client.organizations.list();
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    const sent = headers.get("x-request-id");
    expect(sent).toMatch(/^req_[0-9a-f]{16,}$/);
  });

  it("passes caller-provided request id verbatim", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(SUCCESS_LIST));
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    await client.organizations.list({ requestId: "req_user_supplied_42" });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("x-request-id")).toBe("req_user_supplied_42");
  });

  it("generateRequestId returns a stable shape", () => {
    const id = generateRequestId();
    expect(id).toMatch(/^req_[0-9a-f]+$/);
    expect(id.length).toBeGreaterThan(10);
  });
});

describe("Transport — idempotency key", () => {
  it("does NOT auto-generate an idempotency key on POST", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        { data: { organization: {}, membership: {} }, meta: { requestId: "req_x", cursor: null } },
        { status: 201 },
      ),
    );
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    await client.organizations.create({ name: "Acme" });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBeNull();
  });

  it("propagates a caller-provided idempotency key on POST", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        { data: { organization: {}, membership: {} }, meta: { requestId: "req_x", cursor: null } },
        { status: 201 },
      ),
    );
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    await client.organizations.create(
      { name: "Acme" },
      { idempotencyKey: "ikey_abc123" },
    );
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_abc123");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe(JSON.stringify({ name: "Acme" }));
  });

  it("propagates idempotency key on project create", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(
        { data: { project: {} }, meta: { requestId: "req_x", cursor: null } },
        { status: 201 },
      ),
    );
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    await client.projects.create("org_1", { name: "Web" }, { idempotencyKey: "ikey_proj_1" });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_proj_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/projects");
  });
});

describe("Transport — abort signal", () => {
  it("forwards the abort signal", async () => {
    const { fetch, calls } = captureFetch(jsonResponse(SUCCESS_LIST));
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    const ctrl = new AbortController();
    await client.organizations.list({ signal: ctrl.signal });
    expect(calls[0]!.init.signal).toBe(ctrl.signal);
  });
});

describe("Error decoding — typed branches", () => {
  function envelopeFor(code: string, status: number, extra: Record<string, unknown> = {}): Response {
    return jsonResponse(
      {
        error: {
          code,
          message: `synthetic ${code}`,
          details: extra,
          requestId: "req_server_err",
        },
      },
      { status },
    );
  }

  const cases: Array<[string, number, new (...args: never[]) => MeterwiseError]> = [
    ["bad_request", 400, BadRequestError],
    ["unauthenticated", 401, UnauthenticatedError],
    ["forbidden", 403, ForbiddenError],
    ["not_found", 404, NotFoundError],
    ["conflict", 409, ConflictError],
    ["precondition_failed", 412, PreconditionFailedError],
    ["unsupported", 405, UnsupportedError],
    ["internal_error", 500, InternalError],
  ];

  for (const [code, status, Ctor] of cases) {
    it(`decodes ${code} → ${Ctor.name}`, async () => {
      const { fetch } = captureFetch(envelopeFor(code, status));
      const client = new Meterwise({ baseUrl: "https://api.test", fetch });
      await expect(client.organizations.list()).rejects.toBeInstanceOf(Ctor);
      try {
        await client.organizations.list();
      } catch (err) {
        const e = err as MeterwiseError;
        expect(e.code).toBe(code);
        expect(e.status).toBe(status);
        expect(e.requestId).toBe("req_server_err");
        expect(e.message).toBe(`synthetic ${code}`);
        expect(e).toBeInstanceOf(MeterwiseError);
      }
    });
  }

  it("decodes validation_failed with field map", async () => {
    const { fetch } = captureFetch(
      jsonResponse(
        {
          error: {
            code: "validation_failed",
            message: "Validation failed",
            details: { fields: { name: ["required"] } },
            requestId: "req_v",
          },
        },
        { status: 422 },
      ),
    );
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    try {
      await client.organizations.create({ name: "" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const v = err as ValidationError;
      expect(v.fields).toEqual({ name: ["required"] });
    }
  });

  it("forward-compat: unknown error code → base MeterwiseError", async () => {
    const { fetch } = captureFetch(envelopeFor("future_quota_exceeded", 402));
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    try {
      await client.organizations.list();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MeterwiseError);
      expect(err).not.toBeInstanceOf(BadRequestError);
      expect((err as MeterwiseError).code).toBe("future_quota_exceeded");
    }
  });

  it("non-JSON 5xx body falls back to InternalError shape", async () => {
    const { fetch } = captureFetch(
      new Response("<html>502 bad gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    try {
      await client.organizations.list();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InternalError);
      const e = err as InternalError;
      expect(e.status).toBe(502);
      expect(e.message).toBe("HTTP 502");
      // Caller-supplied request id is used as fallback when server doesn't provide one.
      expect(e.requestId).toMatch(/^req_/);
    }
  });

  it("empty 500 body falls back to InternalError", async () => {
    const { fetch } = captureFetch(new Response("", { status: 500 }));
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    await expect(client.organizations.list()).rejects.toBeInstanceOf(InternalError);
  });
});

describe("Error decoding — RateLimitError", () => {
  function rateLimitedResponse(extra: { headers?: Record<string, string> } = {}): Response {
    return jsonResponse(
      {
        error: {
          code: "rate_limited",
          message: "Too many requests",
          details: { scope: "org", retryAfterSeconds: 7 },
          requestId: "req_rl",
        },
      },
      {
        status: 429,
        headers: {
          "retry-after": "7",
          "x-ratelimit-limit-org": "100",
          "x-ratelimit-remaining-org": "0",
          "x-ratelimit-reset-org": "1717000000",
          "x-ratelimit-limit-identity": "30",
          "x-ratelimit-remaining-identity": "29",
          "x-ratelimit-reset-identity": "1717000010",
          ...(extra.headers ?? {}),
        },
      },
    );
  }

  it("decodes Task 0097 rate-limit envelope completely", async () => {
    const { fetch } = captureFetch(rateLimitedResponse());
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });

    try {
      await client.organizations.list();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      const e = err as RateLimitError;
      expect(e.status).toBe(429);
      expect(e.scope).toBe("org");
      expect(e.retryAfterSeconds).toBe(7);
      expect(e.windows).toHaveLength(2);
      expect(e.orgWindow).toEqual({
        scope: "org",
        limit: 100,
        remaining: 0,
        resetAt: 1717000000,
      });
      expect(e.identityWindow).toEqual({
        scope: "identity",
        limit: 30,
        remaining: 29,
        resetAt: 1717000010,
      });
    }
  });

  it("missing rate-limit headers do not throw — fields are null/empty", async () => {
    const { fetch } = captureFetch(
      jsonResponse(
        {
          error: { code: "rate_limited", message: "rate", details: {}, requestId: "req_rl" },
        },
        { status: 429 },
      ),
    );
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    try {
      await client.organizations.list();
      throw new Error("expected throw");
    } catch (err) {
      const e = err as RateLimitError;
      expect(e).toBeInstanceOf(RateLimitError);
      expect(e.retryAfterSeconds).toBeNull();
      expect(e.scope).toBeNull();
      expect(e.windows).toEqual([]);
    }
  });

  it("falls back to details.retryAfterSeconds when Retry-After header is absent", async () => {
    const { fetch } = captureFetch(
      jsonResponse(
        {
          error: {
            code: "rate_limited",
            message: "rate",
            details: { scope: "identity", retryAfterSeconds: 12 },
            requestId: "req_rl",
          },
        },
        { status: 429 },
      ),
    );
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    try {
      await client.organizations.list();
      throw new Error("expected throw");
    } catch (err) {
      const e = err as RateLimitError;
      expect(e.retryAfterSeconds).toBe(12);
      expect(e.scope).toBe("identity");
    }
  });
});

describe("Resource clients — surface", () => {
  it("projects.list hits the org-scoped path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { projects: [] }, meta: { requestId: "req", cursor: null } }),
    );
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    await client.projects.list("org_1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_1/projects");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("projects.archive issues DELETE", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { project: {} }, meta: { requestId: "req", cursor: null } }),
    );
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    await client.projects.archive("org_1", "proj_1");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/projects/proj_1",
    );
  });

  it("organizations.get hits /:orgId", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse({ data: { organization: {} }, meta: { requestId: "req", cursor: null } }),
    );
    const client = new Meterwise({ baseUrl: "https://api.test", fetch });
    await client.organizations.get("org_42");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_42");
  });
});
