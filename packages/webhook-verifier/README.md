# @saas/webhook-verifier

Zero-dependency, WebCrypto-only HMAC-SHA256 signature verifier for
Meterwise outbound webhook deliveries. Runs verbatim on Cloudflare
Workers, Bun, modern Node, and browsers.

```ts
import {
  verifyWebhookSignature,
  DEFAULT_TOLERANCE_SECONDS,
} from "@saas/webhook-verifier";

export async function handler(request: Request): Promise<Response> {
  const body = await request.text();
  const result = await verifyWebhookSignature({
    secret: process.env.METERWISE_WEBHOOK_SECRET!,
    body,
    headers: request.headers,
    // toleranceSeconds: DEFAULT_TOLERANCE_SECONDS, // 5 minutes; tighten if you have strict NTP
  });
  if (!result.ok) {
    return new Response(`rejected: ${result.reason}`, { status: 401 });
  }
  // body is now trusted — JSON.parse and dispatch on event.type
  return new Response("ok");
}
```

`toleranceSeconds` controls the replay window (default 300s); lower it if
your clocks are tightly synchronized, raise it if they aren't.

The companion `signWebhookPayload({ secret, body, timestamp })` helper
produces the exact `sha256=<hex>` header value Meterwise emits — useful
for fixtures and symmetric debugging.
