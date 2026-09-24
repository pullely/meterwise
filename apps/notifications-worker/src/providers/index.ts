import type { NotificationProvider } from "@saas/contracts/notifications";
import type { Env } from "../env.js";
import { createLocalDebugProvider } from "./local-debug.js";
import { createCloudflareEmailProvider } from "./cloudflare-email.js";

/**
 * Resolve the configured NotificationProvider for this worker instance.
 *
 * Supported values:
 *   - "local-debug"       — records a synthetic send, contacts nothing.
 *   - "cloudflare-email"  — real delivery via the Email Service binding;
 *                            requires the EMAIL send_email binding and
 *                            EMAIL_FROM_ADDRESS to be configured.
 *
 * Unknown values — and a cloudflare-email selection whose binding/from
 * address is missing — fall back to local-debug with a console warning: the
 * worker must always have a working adapter to remain deployable.
 */
export function resolveProvider(env: Env): NotificationProvider {
  const name = (env.NOTIFICATIONS_PROVIDER ?? "local-debug").toLowerCase();
  switch (name) {
    case "local-debug":
      return createLocalDebugProvider();
    case "cloudflare-email": {
      if (!env.EMAIL || !env.EMAIL_FROM_ADDRESS) {
        console.warn(
          "[notifications-worker] NOTIFICATIONS_PROVIDER=cloudflare-email but the EMAIL binding or EMAIL_FROM_ADDRESS is not configured; falling back to local-debug.",
        );
        return createLocalDebugProvider();
      }
      return createCloudflareEmailProvider({
        email: env.EMAIL,
        fromAddress: env.EMAIL_FROM_ADDRESS,
        ...(env.EMAIL_FROM_NAME ? { fromName: env.EMAIL_FROM_NAME } : {}),
      });
    }
    default:
      // Refuse to silently route to a real provider that does not exist.
      // Logging the name (not credentials) is safe.
      console.warn(`[notifications-worker] Unknown NOTIFICATIONS_PROVIDER=${name}; falling back to local-debug.`);
      return createLocalDebugProvider();
  }
}
