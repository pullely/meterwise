import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isLedgerRoute, handleLedgerRoute } from "@api-edge/ledger-facade";
import { isOrgRoute } from "@api-edge/org-facade";

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripJsoncComments(text: string): string {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function recorder(respond: (url: string) => Response): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

/** identity-worker resolving an API key to its service principal. */
function identityForKey(spId: string, orgId: string) {
  return recorder(() =>
    Response.json({
      data: { actor: { actorType: "service_principal", actorId: spId, orgId } },
      meta: { requestId: "req_inner", cursor: null },
    }),
  );
}

describe("api-edge ledger facade", () => {
  it("claims the ledger routes and nothing else", () => {
    for (const p of [
      "/v1/organizations/org_a/llm-events",
      "/v1/organizations/org_a/llm-costs",
      "/v1/organizations/org_a/llm-prices",
    ]) {
      expect(isLedgerRoute(p)).toBe(true);
    }
    for (const p of [
      "/v1/organizations/org_a",
      "/v1/organizations/org_a/projects",
      "/v1/organizations/org_a/api-keys",
      "/v1/organizations/org_a/llm-events/mwe_b",
      "/v1/organizations/org_a/llm-check",
      "/v1/organizations/org_a/llm-costsx",
      "/v1/llm-events",
    ]) {
      expect(isLedgerRoute(p)).toBe(false);
    }
  });

  it("is dispatched before the org facade would swallow it", () => {
    expect(isLedgerRoute("/v1/organizations/org_a/llm-events")).toBe(true);
    expect(typeof isOrgRoute("/v1/organizations/org_a/llm-events")).toBe("boolean");
  });

  it("forwards an API-key ingest to LEDGER_WORKER as the key's service principal, never the caller's own headers", async () => {
    const id = identityForKey("sp_0123456789abcdef0123456789abcdef", "org_a");
    const worker = recorder(() =>
      Response.json({ data: { accepted: 1 }, meta: { requestId: "req_test", cursor: null } }, { status: 200 }),
    );
    const request = new Request("https://api.example.com/v1/organizations/org_a/llm-events", {
      method: "POST",
      headers: {
        authorization: "Bearer sk_live_customer_ingest_key",
        "content-type": "application/json",
        "x-actor-subject-id": "usr_spoofed",
        "x-actor-subject-type": "user",
      },
      body: JSON.stringify({ events: [] }),
    });
    const response = await handleLedgerRoute(
      request,
      { IDENTITY_WORKER: id.fetcher, LEDGER_WORKER: worker.fetcher, ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/llm-events",
    );
    expect(response.status).toBe(200);
    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0]!.url).toBe("https://ledger.internal/v1/organizations/org_a/llm-events");
    const headers = new Headers(worker.calls[0]!.init.headers);
    expect(headers.get("x-actor-subject-id")).toBe("sp_0123456789abcdef0123456789abcdef");
    expect(headers.get("x-actor-subject-type")).toBe("service_principal");
    // The bearer stops at the edge: the worker never sees the key.
    expect(headers.get("authorization")).toBeNull();
  });

  it("keeps the query string on reads", async () => {
    const id = identityForKey("sp_0123456789abcdef0123456789abcdef", "org_a");
    const worker = recorder(() => Response.json({ data: {}, meta: { requestId: "r", cursor: null } }));
    await handleLedgerRoute(
      new Request("https://api.example.com/v1/organizations/org_a/llm-costs?by=model&from=2026-09-01", {
        headers: { authorization: "Bearer k" },
      }),
      { IDENTITY_WORKER: id.fetcher, LEDGER_WORKER: worker.fetcher, ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/llm-costs",
    );
    expect(worker.calls[0]!.url).toBe("https://ledger.internal/v1/organizations/org_a/llm-costs?by=model&from=2026-09-01");
  });

  it("answers 401 without a bearer, or with a key identity refuses, and never reaches the worker", async () => {
    const id = recorder(() => Response.json({ error: { code: "unauthenticated", message: "no", details: {}, requestId: "r" } }, { status: 401 }));
    const worker = recorder(() => Response.json({}));
    for (const headers of [{}, { authorization: "Bearer revoked_key" }]) {
      const response = await handleLedgerRoute(
        new Request("https://api.example.com/v1/organizations/org_a/llm-events", { method: "POST", headers, body: "{}" }),
        { IDENTITY_WORKER: id.fetcher, LEDGER_WORKER: worker.fetcher, ENVIRONMENT: "test" },
        "req_test",
        "/v1/organizations/org_a/llm-events",
      );
      expect(response.status).toBe(401);
    }
    expect(worker.calls).toHaveLength(0);
  });

  it("answers 503 when the binding is missing", async () => {
    const response = await handleLedgerRoute(
      new Request("https://api.example.com/v1/organizations/org_a/llm-costs"),
      { ENVIRONMENT: "test" },
      "req_test",
      "/v1/organizations/org_a/llm-costs",
    );
    expect(response.status).toBe(503);
  });

  it("wrangler.jsonc binds LEDGER_WORKER on stage and prod", () => {
    const raw = readFileSync(resolve(__dirname, "../../../apps/api-edge/wrangler.jsonc"), "utf8");
    const config = JSON.parse(stripJsoncComments(raw)) as {
      env: Record<string, { services?: { binding: string; service: string }[] }>;
    };
    for (const env of ["stage", "prod"]) {
      const binding = config.env[env]!.services!.find((s) => s.binding === "LEDGER_WORKER");
      expect(binding?.service).toBe(`meterwise-ledger-worker-${env}`);
    }
  });
});
