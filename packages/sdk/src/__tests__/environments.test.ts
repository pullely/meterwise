// Tests for `EnvironmentsClient` (Task 0102 — closes Task 0101 spec gap).
//
// Coverage:
//   - URL shape on every method (list/get/create/archive)
//   - encodeURIComponent on dynamic segments (org / project / environment id)
//   - Stripe parity: idempotency-key passthrough on create + archive
//   - Stripe parity NOT auto-generated when caller omits the key
//   - MeterwiseError hierarchy propagation with request-id passthrough

import { describe, expect, it, vi } from "vitest";

import { Meterwise } from "../index.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";

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
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function envelope<T>(
  data: T,
): { data: T; meta: { requestId: string; cursor: null } } {
  return { data, meta: { requestId: "req_test", cursor: null } };
}

function errorResponse(code: string, status: number): Response {
  return jsonResponse(
    {
      error: {
        code,
        message: `synthetic ${code}`,
        details: { fields: { name: ["already_taken"] } },
        requestId: "req_err",
      },
    },
    { status },
  );
}

function client(fetchImpl: typeof fetch): Meterwise {
  return new Meterwise({ baseUrl: "https://api.test", fetch: fetchImpl });
}

describe("EnvironmentsClient", () => {
  it("list hits the project-scoped environments path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ environments: [] })),
    );
    await client(fetch).environments.list("org_1", "prj_1");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/projects/prj_1/environments",
    );
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("list encodeURIComponent-encodes dynamic segments", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ environments: [] })),
    );
    // Org/project ids that need encoding (slash, space) prove the SDK does
    // not concatenate raw — guards against a future refactor that drops the
    // encoder.
    await client(fetch).environments.list("org with space", "prj/slash");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org%20with%20space/projects/prj%2Fslash/environments",
    );
  });

  it("get hits the environment-scoped path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ environment: {} })),
    );
    await client(fetch).environments.get("org_1", "prj_1", "env_1");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/projects/prj_1/environments/env_1",
    );
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("get encodeURIComponent-encodes the env id", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ environment: {} })),
    );
    await client(fetch).environments.get("org_1", "prj_1", "env id/x");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/projects/prj_1/environments/env%20id%2Fx",
    );
  });

  it("create POSTs the body and propagates idempotency-key", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ environment: {} }), { status: 201 }),
    );
    await client(fetch).environments.create(
      "org_1",
      "prj_1",
      { name: "staging" },
      { idempotencyKey: "ikey_env_1" },
    );
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://api.test/v1/organizations/org_1/projects/prj_1/environments",
    );
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({ name: "staging" });
    const headers = new Headers(call.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_env_1");
  });

  it("create does NOT auto-generate an idempotency-key when omitted", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ environment: {} }), { status: 201 }),
    );
    await client(fetch).environments.create("org_1", "prj_1", { name: "staging" });
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    // Stripe parity: caller-owned only.
    expect(headers.get("idempotency-key")).toBeNull();
  });

  it("archive issues DELETE on the env-scoped path", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ environment: {} })),
    );
    await client(fetch).environments.archive("org_1", "prj_1", "env_42");
    expect(calls[0]!.url).toBe(
      "https://api.test/v1/organizations/org_1/projects/prj_1/environments/env_42",
    );
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("archive propagates idempotency-key", async () => {
    const { fetch, calls } = captureFetch(
      jsonResponse(envelope({ environment: {} })),
    );
    await client(fetch).environments.archive(
      "org_1",
      "prj_1",
      "env_42",
      { idempotencyKey: "ikey_arc_1" },
    );
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("idempotency-key")).toBe("ikey_arc_1");
  });

  it("create surfaces ValidationError on 422 with request-id", async () => {
    const { fetch } = captureFetch(errorResponse("validation_failed", 422));
    await expect(
      client(fetch).environments.create("org_1", "prj_1", { name: "" }),
    ).rejects.toMatchObject({
      constructor: ValidationError,
      requestId: "req_err",
    });
  });

  it("get surfaces NotFoundError on 404", async () => {
    const { fetch } = captureFetch(errorResponse("not_found", 404));
    await expect(
      client(fetch).environments.get("org_1", "prj_1", "env_x"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("create surfaces ConflictError on 409", async () => {
    const { fetch } = captureFetch(errorResponse("conflict", 409));
    await expect(
      client(fetch).environments.create("org_1", "prj_1", { name: "staging" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
