// Health contract types

export interface HealthResponse {
  status: "ok" | "degraded" | "down";
  service: string;
  environment: string;
  timestamp: string;
  version?: string;
}

export const HEALTH_STATUS = {
  OK: "ok",
  DEGRADED: "degraded",
  DOWN: "down",
} as const;

export type HealthStatus = (typeof HEALTH_STATUS)[keyof typeof HEALTH_STATUS];
