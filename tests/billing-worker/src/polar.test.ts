import { createHmac } from "node:crypto";
import {
  createPolarProvider,
  buildBillingProviderRegistry,
} from "@billing-worker/billing-provider/polar";
import type { PolarConfig } from "@billing-worker/billing-provider/polar-mapping";
import type { Env } from "@billing-worker/env";

// Polar's validateEvent uses the raw UTF-8 bytes of the secret string as the
// HMAC key (it base64-wraps the secret, which standardwebhooks base64-decodes
// straight back), so sign with the same key here.
const SECRET = "polar-test-signing-secret";

const config = (): PolarConfig => ({
  accessToken: "polar_pat_test",
  server: "sandbox",
  webhookSecret: SECRET,
  productMap: { pro: "prod_p", business: "prod_b" },
  successUrl: null,
});

/** Produce a valid Standard-Webhooks signature over the raw body. */
function signedHeaders(body: string, opts: { secret?: string; id?: string } = {}) {
  const id = opts.id ?? "msg_test";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const key = Buffer.from(opts.secret ?? SECRET, "utf-8");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature}`,
  };
}

describe("buildBillingProviderRegistry", () => {
  it("fails closed (not_configured) when Polar is not fully configured", () => {
    const reg = buildBillingProviderRegistry({ ENVIRONMENT: "test" } as Env);
    expect(reg.get("polar")).toBeNull();
    expect(reg.resolve({})).toEqual({ ok: false, reason: "not_configured" });
  });

  it("registers Polar when access token + webhook secret are present", () => {
    const reg = buildBillingProviderRegistry({
      ENVIRONMENT: "test",
      POLAR_ACCESS_TOKEN: "tok",
      POLAR_WEBHOOK_SECRET: SECRET,
    } as Env);
    expect(reg.get("polar")?.id).toBe("polar");
    const res = reg.resolve({});
    expect(res.ok).toBe(true);
  });
});

describe("polar verifyWebhook", () => {
  it("rejects a bad signature with invalid_signature", async () => {
    const provider = createPolarProvider(config());
    const body = JSON.stringify({ type: "subscription.active", data: {} });
    const res = await provider.verifyWebhook(body, {
      "webhook-id": "msg_x",
      "webhook-timestamp": Math.floor(Date.now() / 1000).toString(),
      "webhook-signature": "v1,not-a-real-signature",
    });
    expect(res).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const provider = createPolarProvider(config());
    const body = JSON.stringify({ type: "subscription.active", data: {} });
    const res = await provider.verifyWebhook(body, signedHeaders(body, { secret: "a-different-secret" }));
    expect(res).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("accepts a valid signature but reports malformed when the payload fails schema validation", async () => {
    const provider = createPolarProvider(config());
    // Correctly signed, JSON-parseable, but not a schema-valid subscription payload.
    const body = JSON.stringify({ type: "subscription.active", data: {} });
    const res = await provider.verifyWebhook(body, signedHeaders(body));
    expect(res).toEqual({ ok: false, reason: "malformed" });
  });
});
