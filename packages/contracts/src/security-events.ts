// Public contract types for identity security-event listing.

/**
 * A single security event in the public response shape.
 * Sensitive fields (codes, tokens, hashes) are never included.
 * Metadata is redacted according to stored redactPaths before serialization.
 */
export interface PublicSecurityEvent {
  /** Opaque event identifier */
  id: string;
  /** Event type, e.g. "login.challenge.created", "session.created" */
  eventType: string;
  /** Outcome: "success" or "failure" */
  outcome: string;
  /** ISO 8601 timestamp of when the event occurred */
  occurredAt: string;
  /** Request context */
  requestId: string | null;
  correlationId: string | null;
  ip: string | null;
  userAgent: string | null;
  /** Redacted metadata payload (safe subset) */
  metadata: Record<string, unknown>;
}

export interface SecurityEventListResponse {
  securityEvents: PublicSecurityEvent[];
}
