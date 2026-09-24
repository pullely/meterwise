import type { CloudflareEmailSender } from "./providers/cloudflare-email.js";

export interface Env {
  PLATFORM_DB?: D1Database;
  EVENTS_WORKER?: Fetcher;
  /** Cloudflare Email Service send_email binding (cloudflare-email provider). */
  EMAIL?: CloudflareEmailSender;
  ENVIRONMENT: string;
  /** Provider selector: "local-debug" (default) or "cloudflare-email". */
  NOTIFICATIONS_PROVIDER?: string;
  DEBUG_DELIVERY?: string;
  /** Verified sender address for the cloudflare-email provider. */
  EMAIL_FROM_ADDRESS?: string;
  /** Optional sender display name / brand for the cloudflare-email provider. */
  EMAIL_FROM_NAME?: string;
}
