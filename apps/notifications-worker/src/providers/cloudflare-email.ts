import type {
  NotificationProvider,
  ProviderSendContext,
  ProviderSendResult,
} from "@saas/contracts/notifications";
import { renderEmailTemplate } from "../templates/index.js";

/**
 * Cloudflare Email Service provider.
 *
 * Sends real transactional email through the Workers `send_email` binding
 * (Cloudflare Email Service). Unlike Resend/Postmark/SES there is no API key
 * to inject — the binding is the credential, scoped to this worker by the
 * deploy-time wrangler config.
 *
 * Operational prerequisites (one-time, per Cloudflare account):
 *   - Workers Paid plan (required to send to arbitrary recipients),
 *   - the sending domain verified in Email Service (DKIM/SPF records),
 *   - EMAIL_FROM_ADDRESS on that verified domain.
 *
 * The adapter renders the template itself (templates/index.ts) so that
 * provider-specific payloads stay behind this seam per spec 14: callers only
 * ever see templateKey + templateData.
 */

/** Message shape accepted by the Email Service binding's send(). */
export interface CloudflareEmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface CloudflareEmailSendResult {
  messageId: string;
}

/**
 * Structural type for the `send_email` binding. Declared locally because the
 * pinned @cloudflare/workers-types predates the Email Service binding API;
 * it also keeps the adapter trivially fakeable in tests.
 */
export interface CloudflareEmailSender {
  send(message: CloudflareEmailMessage): Promise<CloudflareEmailSendResult>;
}

export interface CloudflareEmailProviderOptions {
  email: CloudflareEmailSender;
  /** Verified sender address, e.g. "no-reply@mail.example.com". */
  fromAddress: string;
  /** Optional display name rendered as `Name <address>` and used for branding copy. */
  fromName?: string;
}

/**
 * Bound the error string persisted to notification_attempts.error_reason.
 * Runtime errors from the binding are short, but the contract requires a
 * scrubbed, single-line, bounded value — never a raw provider payload.
 */
function boundedErrorReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, 160);
  return cleaned.length > 0 ? `cloudflare_email_send_failed: ${cleaned}` : "cloudflare_email_send_failed";
}

export function createCloudflareEmailProvider(
  opts: CloudflareEmailProviderOptions,
): NotificationProvider {
  const from = opts.fromName ? `${opts.fromName} <${opts.fromAddress}>` : opts.fromAddress;
  return {
    name: "cloudflare-email",
    async send(ctx: ProviderSendContext): Promise<ProviderSendResult> {
      const rendered = renderEmailTemplate(ctx.templateKey, ctx.templateData, {
        ...(opts.fromName ? { brandName: opts.fromName } : {}),
      });
      if (!rendered) {
        // Refuse to deliver an empty/generic body for a key nobody registered;
        // the bounded reason surfaces the gap through notification.failed.
        return {
          ok: false,
          providerMessageId: null,
          errorReason: `unknown_template:${ctx.templateKey}`,
        };
      }

      try {
        const result = await opts.email.send({
          from,
          to: ctx.recipient.address,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        });
        if (!result || typeof result.messageId !== "string" || result.messageId.length === 0) {
          return {
            ok: false,
            providerMessageId: null,
            errorReason: "cloudflare_email_missing_message_id",
          };
        }
        return { ok: true, providerMessageId: result.messageId };
      } catch (err) {
        return { ok: false, providerMessageId: null, errorReason: boundedErrorReason(err) };
      }
    },
  };
}
