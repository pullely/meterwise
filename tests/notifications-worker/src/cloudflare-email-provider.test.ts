import {
  createCloudflareEmailProvider,
  type CloudflareEmailMessage,
  type CloudflareEmailSendResult,
  type CloudflareEmailSender,
} from "@notifications-worker/providers/cloudflare-email";
import { resolveProvider } from "@notifications-worker/providers/index";
import { renderEmailTemplate } from "@notifications-worker/templates/index";
import type { Env } from "@notifications-worker/env";
import type { ProviderSendContext } from "@saas/contracts/notifications";

interface FakeSender extends CloudflareEmailSender {
  sent: CloudflareEmailMessage[];
}

function createFakeSender(
  result: CloudflareEmailSendResult | (() => Promise<CloudflareEmailSendResult>) = {
    messageId: "cf-msg-1",
  },
): FakeSender {
  const sent: CloudflareEmailMessage[] = [];
  return {
    sent,
    async send(message: CloudflareEmailMessage) {
      sent.push(message);
      return typeof result === "function" ? result() : result;
    },
  };
}

function magicLinkCtx(overrides: Partial<ProviderSendContext> = {}): ProviderSendContext {
  return {
    notificationId: "11111111-1111-4111-8111-111111111111",
    orgId: "00000000-0000-0000-0000-000000000000",
    category: "security",
    templateKey: "auth.magic_link",
    templateData: {
      code: "123456",
      emailHint: "u***@example.com",
      expiresAt: "2026-06-12T10:30:00.000Z",
      requestId: "req-1",
    },
    recipient: { channel: "email", address: "user@example.com" },
    ...overrides,
  };
}

describe("cloudflare-email provider", () => {
  test("sends a rendered auth.magic_link email and returns the provider message id", async () => {
    const sender = createFakeSender({ messageId: "cf-msg-42" });
    const provider = createCloudflareEmailProvider({
      email: sender,
      fromAddress: "no-reply@mail.example.com",
      fromName: "Acme",
    });

    const result = await provider.send(magicLinkCtx());

    expect(result).toEqual({ ok: true, providerMessageId: "cf-msg-42" });
    expect(sender.sent).toHaveLength(1);
    const msg = sender.sent[0]!;
    expect(msg.to).toBe("user@example.com");
    expect(msg.from).toBe("Acme <no-reply@mail.example.com>");
    expect(msg.subject).toBe("Your Acme login code");
    expect(msg.html).toContain("123456");
    expect(msg.text).toContain("123456");
    expect(msg.text).toContain("expires");
  });

  test("uses the bare from address when no fromName is configured", async () => {
    const sender = createFakeSender();
    const provider = createCloudflareEmailProvider({
      email: sender,
      fromAddress: "no-reply@mail.example.com",
    });

    await provider.send(magicLinkCtx());

    expect(sender.sent[0]!.from).toBe("no-reply@mail.example.com");
    expect(sender.sent[0]!.subject).toBe("Your login code");
  });

  test("html-escapes templateData substitutions", async () => {
    const sender = createFakeSender();
    const provider = createCloudflareEmailProvider({
      email: sender,
      fromAddress: "no-reply@mail.example.com",
    });

    await provider.send(
      magicLinkCtx({
        templateData: {
          code: '<script>alert("x")</script>',
          expiresAt: "not-a-date",
        },
      }),
    );

    const msg = sender.sent[0]!;
    expect(msg.html).not.toContain("<script>");
    expect(msg.html).toContain("&lt;script&gt;");
    // Unparseable timestamps fall back to the raw value instead of failing.
    expect(msg.text).toContain("not-a-date");
  });

  test("fails with a bounded reason for an unregistered template key without contacting the binding", async () => {
    const sender = createFakeSender();
    const provider = createCloudflareEmailProvider({
      email: sender,
      fromAddress: "no-reply@mail.example.com",
    });

    const result = await provider.send(magicLinkCtx({ templateKey: "billing.receipt" }));

    expect(result).toEqual({
      ok: false,
      providerMessageId: null,
      errorReason: "unknown_template:billing.receipt",
    });
    expect(sender.sent).toHaveLength(0);
  });

  test("maps a thrown binding error to a single-line bounded errorReason", async () => {
    const sender = createFakeSender(() =>
      Promise.reject(new Error("delivery rejected\nupstream said:\t" + "x".repeat(500))),
    );
    const provider = createCloudflareEmailProvider({
      email: sender,
      fromAddress: "no-reply@mail.example.com",
    });

    const result = await provider.send(magicLinkCtx());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.providerMessageId).toBeNull();
      expect(result.errorReason.startsWith("cloudflare_email_send_failed: delivery rejected")).toBe(true);
      expect(result.errorReason).not.toMatch(/[\r\n\t]/);
      expect(result.errorReason.length).toBeLessThanOrEqual(200);
    }
  });

  test("fails when the binding returns no messageId", async () => {
    const sender = createFakeSender({} as CloudflareEmailSendResult);
    const provider = createCloudflareEmailProvider({
      email: sender,
      fromAddress: "no-reply@mail.example.com",
    });

    const result = await provider.send(magicLinkCtx());

    expect(result).toEqual({
      ok: false,
      providerMessageId: null,
      errorReason: "cloudflare_email_missing_message_id",
    });
  });
});

describe("email templates", () => {
  test("renders invitation.created with role and expiry", () => {
    const rendered = renderEmailTemplate(
      "invitation.created",
      {
        role: "admin",
        invitationId: "inv_abc",
        expiresAt: "2026-06-19T00:00:00.000Z",
        invitedBy: "user_123",
        orgId: "org_456",
      },
      { brandName: "Acme" },
    );

    expect(rendered).not.toBeNull();
    expect(rendered!.subject).toBe("You have been invited to an organization on Acme");
    expect(rendered!.text).toContain("as admin");
    expect(rendered!.text).toContain("expires at");
    expect(rendered!.html).toContain("as admin");
  });

  test("renders invitation.accepted with the granted role", () => {
    const rendered = renderEmailTemplate("invitation.accepted", {
      invitationId: "inv_abc",
      role: "member",
      memberId: "mem_789",
      orgId: "org_456",
    });

    expect(rendered).not.toBeNull();
    expect(rendered!.subject).toBe("You have joined an organization");
    expect(rendered!.text).toContain("member role");
  });

  test("returns null for unknown template keys", () => {
    expect(renderEmailTemplate("nope.unknown", {})).toBeNull();
  });
});

describe("resolveProvider cloudflare-email wiring", () => {
  const baseEnv: Env = { ENVIRONMENT: "test" };

  test("returns the cloudflare-email provider when binding and from address are configured", () => {
    const env: Env = {
      ...baseEnv,
      NOTIFICATIONS_PROVIDER: "cloudflare-email",
      EMAIL: createFakeSender(),
      EMAIL_FROM_ADDRESS: "no-reply@mail.example.com",
      EMAIL_FROM_NAME: "Acme",
    };
    expect(resolveProvider(env).name).toBe("cloudflare-email");
  });

  test("falls back to local-debug when the EMAIL binding is missing", () => {
    const env: Env = {
      ...baseEnv,
      NOTIFICATIONS_PROVIDER: "cloudflare-email",
      EMAIL_FROM_ADDRESS: "no-reply@mail.example.com",
    };
    expect(resolveProvider(env).name).toBe("local-debug");
  });

  test("falls back to local-debug when EMAIL_FROM_ADDRESS is missing", () => {
    const env: Env = {
      ...baseEnv,
      NOTIFICATIONS_PROVIDER: "cloudflare-email",
      EMAIL: createFakeSender(),
    };
    expect(resolveProvider(env).name).toBe("local-debug");
  });
});
