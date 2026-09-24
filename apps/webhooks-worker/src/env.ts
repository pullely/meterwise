export interface Env {
  PLATFORM_DB?: D1Database;
  MEMBERSHIP_WORKER?: Fetcher;
  POLICY_WORKER?: Fetcher;
  ENVIRONMENT: string;
  /** Hex-encoded 256-bit key for signing-secret encryption (AES-256-GCM). */
  SECRET_ENCRYPTION_KEY?: string;
  /**
   * Optional override (in seconds) for the dual-signature grace window
   * applied on signing-secret rotation. When set and > 0, rotated endpoints
   * keep their previous secret active for this many seconds and outbound
   * deliveries attach an additional `X-Webhook-Signature-Previous` header
   * during the window. Default: 86400 (24h). Set to "0" to disable.
   */
  WEBHOOK_SECRET_ROTATION_GRACE_SECONDS?: string;
}
