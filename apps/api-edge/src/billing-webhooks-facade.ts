import type { Env } from "./env";
import { errorResponse } from "./http";

/**
 * Public, unauthenticated inbound billing-provider webhook receiver (BP2).
 *
 * This is the one billing route with no session: the provider (Polar) calls it
 * directly. api-edge does NOT verify or parse — it streams the RAW body and the
 * Standard-Webhooks signature headers to billing-worker, which holds the signing
 * secret and verifies (fails closed). Keeping verification at the billing-worker
 * means the provider secret never lives at the edge.
 */

const POLAR_WEBHOOK_RE = /^\/v1\/billing\/webhooks\/polar$/;

// Signature + content headers the downstream verifier needs. Standard-Webhooks
// uses `webhook-*`; `svix-*` aliases are forwarded for compatibility.
const FORWARDED_WEBHOOK_HEADERS = [
  "content-type",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "svix-id",
  "svix-timestamp",
  "svix-signature",
];

export function isBillingWebhookRoute(pathname: string): boolean {
  return POLAR_WEBHOOK_RE.test(pathname);
}

export async function handleBillingWebhookRoute(
  request: Request,
  env: Env,
  requestId: string,
  _pathname: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("method_not_allowed", "Method not allowed", 405, requestId);
  }
  if (!env.BILLING_WORKER) {
    return errorResponse("service_unavailable", "Billing service unavailable", 503, requestId);
  }

  const headers = new Headers();
  headers.set("x-request-id", requestId);
  headers.set("x-internal-caller", "api-edge");
  for (const name of FORWARDED_WEBHOOK_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  // Stream the raw body through unread so the bytes the provider signed reach
  // the verifier intact.
  const target = new URL("/v1/internal/billing/webhooks/polar", "https://billing.internal");
  return env.BILLING_WORKER.fetch(target.toString(), {
    method: "POST",
    headers,
    body: request.body,
  });
}
