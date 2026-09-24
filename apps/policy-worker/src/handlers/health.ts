import type { Env } from "../env.js";
import { POLICY_VERSION } from "@saas/contracts/policy";

export function handleHealth(env: Env, requestId: string): Response {
  return Response.json(
    {
      status: "ok",
      service: "policy-worker",
      environment: env.ENVIRONMENT ?? "local",
      timestamp: new Date().toISOString(),
      policyVersion: POLICY_VERSION,
    },
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
    },
  );
}
