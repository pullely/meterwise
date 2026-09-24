import {
  isBillingWebhookRoute,
  handleBillingWebhookRoute,
} from "@api-edge/billing-webhooks-facade";

interface FetchCall {
  url: string;
  init: RequestInit;
}

function createFakeFetcher(): { fetcher: Fetcher; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = {
    fetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(Response.json({ data: { received: true }, meta: { requestId: "req_inner" } }));
    },
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
  return { fetcher, calls };
}

function webhookReq(method = "POST"): Request {
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      "webhook-id": "msg_1",
      "webhook-timestamp": "1700000000",
      "webhook-signature": "v1,abc",
    },
  };
  if (method === "POST") init.body = '{"type":"subscription.active"}';
  return new Request("https://api.example/v1/billing/webhooks/polar", init);
}

describe("isBillingWebhookRoute", () => {
  it("matches the polar webhook path only", () => {
    expect(isBillingWebhookRoute("/v1/billing/webhooks/polar")).toBe(true);
    expect(isBillingWebhookRoute("/v1/billing/webhooks/stripe")).toBe(false);
    expect(isBillingWebhookRoute("/v1/organizations/org_x/billing/summary")).toBe(false);
  });
});

describe("handleBillingWebhookRoute", () => {
  it("forwards to billing-worker with the internal-caller + signature headers", async () => {
    const { fetcher, calls } = createFakeFetcher();
    const env = { ENVIRONMENT: "test", BILLING_WORKER: fetcher } as unknown as Parameters<
      typeof handleBillingWebhookRoute
    >[1];
    const res = await handleBillingWebhookRoute(webhookReq(), env, "req_t", "/v1/billing/webhooks/polar");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/v1/internal/billing/webhooks/polar");
    const headers = calls[0]!.init.headers as Headers;
    expect(headers.get("x-internal-caller")).toBe("api-edge");
    expect(headers.get("webhook-signature")).toBe("v1,abc");
    expect(headers.get("webhook-id")).toBe("msg_1");
  });

  it("rejects non-POST with 405", async () => {
    const { fetcher } = createFakeFetcher();
    const env = { ENVIRONMENT: "test", BILLING_WORKER: fetcher } as unknown as Parameters<
      typeof handleBillingWebhookRoute
    >[1];
    const res = await handleBillingWebhookRoute(webhookReq("GET"), env, "req_t", "/v1/billing/webhooks/polar");
    expect(res.status).toBe(405);
  });

  it("returns 503 when the billing-worker binding is missing", async () => {
    const env = { ENVIRONMENT: "test" } as unknown as Parameters<typeof handleBillingWebhookRoute>[1];
    const res = await handleBillingWebhookRoute(webhookReq(), env, "req_t", "/v1/billing/webhooks/polar");
    expect(res.status).toBe(503);
  });
});
