import type { Env } from "../env.js";
import { successResponse } from "../http.js";

export function handleHealth(env: Env, requestId: string): Response {
  const dbConfigured = !!env.PLATFORM_DB;
  const membershipConfigured = !!env.MEMBERSHIP_WORKER;
  const policyConfigured = !!env.POLICY_WORKER;
  const billingConfigured = !!env.BILLING_WORKER;
  // D1 gate: live GitHub paths stay parked until the per-environment App
  // registration provides these secrets. Presence only — never values.
  const githubAppConfigured = !!(
    env.GITHUB_APP_ID &&
    env.GITHUB_APP_PRIVATE_KEY &&
    env.GITHUB_APP_WEBHOOK_SECRET
  );

  return successResponse(
    {
      service: "integrations-worker",
      environment: env.ENVIRONMENT ?? "local",
      checks: {
        database: { configured: dbConfigured },
        membership: { configured: membershipConfigured },
        policy: { configured: policyConfigured },
        billing: { configured: billingConfigured },
        githubApp: { configured: githubAppConfigured },
      },
    },
    requestId,
  );
}
