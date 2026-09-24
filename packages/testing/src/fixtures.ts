import type { TenantContext, HealthResponse } from "@saas/contracts";

export function makeTenantContext(
  overrides?: Partial<TenantContext>
): TenantContext {
  return {
    orgId: "org_test",
    actorId: "user_test",
    actorKind: "user",
    ...overrides,
  };
}

export function makeHealthResponse(
  overrides?: Partial<HealthResponse>
): HealthResponse {
  return {
    status: "ok",
    service: "test-service",
    environment: "test",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}
