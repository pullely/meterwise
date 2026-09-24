// POST /ingress/github/webhook — the verify-and-persist half of the inbound
// pipeline (design §5/§6, R2). Budget: verify + insert + ack; everything
// else is the cron drain's job.
//
// Rules on this bearer-less surface:
//   - raw body first: the HMAC is over raw bytes, verified before any parse
//   - constant-time compare (inside the provider adapter)
//   - body-size cap; immediate 401 on signature failure with no detail and
//     no tenant attribution cost
//   - the inbox row keyed by X-GitHub-Delivery is the idempotency ledger:
//     redeliveries are acknowledged no-ops

import type { Env } from "../env.js";
import type { SqlExecutor } from "@saas/db/d1";
import { createIntegrationsRepository } from "@saas/db/integrations";
import { createSqlExecutor } from "@saas/db/d1";
import { errorResponse, successResponse } from "../http.js";
import { generateUuid } from "../ids.js";
import { getConfiguredProvider } from "../providers/registry.js";
import type { FetchLike } from "../github-app.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MiB — push payloads are chunky
const DELIVERY_KEY_RE = /^[\w-]{1,128}$/;
const EVENT_TYPE_RE = /^[a-z_]{1,64}$/;

export interface IngestDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
}

export async function handleGithubWebhookIngest(
  request: Request,
  env: Env,
  requestId: string,
  deps?: IngestDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  // No webhook secret for this environment yet (D1) → nothing can verify.
  const configured = getConfiguredProvider(env, "github", deps?.fetchImpl);
  if (!configured) {
    return errorResponse("internal_error", "Ingress not configured", 503, requestId);
  }

  const deliveryKey = request.headers.get("x-github-delivery");
  const eventType = request.headers.get("x-github-event");
  if (!deliveryKey || !DELIVERY_KEY_RE.test(deliveryKey)) {
    return errorResponse("bad_request", "Missing delivery id", 400, requestId);
  }
  if (!eventType || !EVENT_TYPE_RE.test(eventType)) {
    return errorResponse("bad_request", "Missing event type", 400, requestId);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    return errorResponse("bad_request", "Payload too large", 413, requestId);
  }

  let rawBody: ArrayBuffer;
  try {
    rawBody = await request.arrayBuffer();
  } catch {
    return errorResponse("bad_request", "Unreadable body", 400, requestId);
  }
  if (rawBody.byteLength === 0 || rawBody.byteLength > MAX_BODY_BYTES) {
    return errorResponse("bad_request", "Payload too large", 413, requestId);
  }

  // Verify BEFORE parse, immediate 401 without detail on failure.
  const signatureOk = await configured.provider.verifyInboundSignature(
    rawBody,
    request.headers.get("x-hub-signature-256"),
  );
  if (!signatureOk) {
    return errorResponse("unauthenticated", "Unauthorized", 401, requestId);
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return errorResponse("bad_request", "Invalid payload", 400, requestId);
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return errorResponse("bad_request", "Invalid payload", 400, requestId);
  }

  const action = typeof payload.action === "string" ? payload.action : null;

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);
    const inserted = await repo.insertInboundDelivery({
      id: generateUuid(),
      provider: "github",
      deliveryKey,
      eventType,
      action,
      payload,
      signatureOk: true,
    });
    if (!inserted.ok) {
      // Durable-inbox write failed: surface 500 so GitHub redelivers.
      return errorResponse("internal_error", "Service unavailable", 500, requestId);
    }
    return successResponse(
      { received: true, duplicate: !inserted.value.created },
      requestId,
      inserted.value.created ? 202 : 200,
    );
  } catch {
    return errorResponse("internal_error", "Service unavailable", 500, requestId);
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
