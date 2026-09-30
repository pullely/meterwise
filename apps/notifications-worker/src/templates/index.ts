/**
 * Static email templates for the notifications worker.
 *
 * Spec 14 allows V1 templates to be static files as long as template
 * versions remain traceable — these renderers are the V1 "static files"
 * form, keyed by the same `templateKey` strings the calling workers pass
 * to POST /v1/notifications.
 *
 * Every substitution is HTML-escaped before it reaches the html body, so a
 * hostile value in `templateData` (or a recipient-controlled field such as
 * an email hint) can never inject markup. Renderers only read the fields
 * they need; unknown extra fields are ignored, and unknown template keys
 * return null so the provider can fail the send with a bounded reason
 * instead of delivering an empty message.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export type TemplateData = Record<string, string | number | boolean | null>;

export interface TemplateRenderOptions {
  /**
   * Product display name used in subjects/footers (e.g. "Meterwise").
   * Falls back to neutral copy when not configured so a misconfigured
   * deployment still produces a sensible email.
   */
  brandName?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Stringify a templateData value; null/undefined render as "". */
function str(data: TemplateData, key: string): string {
  const v = data[key];
  if (v === null || v === undefined) return "";
  return String(v);
}

/**
 * Render an ISO timestamp as a human-readable UTC string. Falls back to the
 * raw value when it does not parse — a slightly ugly email beats a failed
 * send.
 */
function formatTimestamp(raw: string): string {
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toUTCString();
}

/**
 * Shared shell so all transactional emails look consistent. Body fragments
 * passed in MUST already be escaped.
 */
function htmlShell(title: string, bodyHtml: string, footerLine: string): string {
  return [
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background-color:#f4f4f7;">',
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;color:#1a1a2e;">',
    '<div style="background:#ffffff;border-radius:8px;padding:32px;">',
    `<h1 style="margin:0 0 16px;font-size:20px;">${title}</h1>`,
    bodyHtml,
    "</div>",
    `<p style="margin:16px 0 0;font-size:12px;color:#6b6b80;text-align:center;">${footerLine}</p>`,
    "</div></body></html>",
  ].join("");
}

type TemplateRenderer = (data: TemplateData, opts: TemplateRenderOptions) => RenderedEmail;

const renderMagicLink: TemplateRenderer = (data, opts) => {
  const code = str(data, "code");
  const expires = formatTimestamp(str(data, "expiresAt"));
  const brand = opts.brandName ?? "";
  const subject = brand ? `Your ${brand} login code` : "Your login code";
  const expiryLineText = expires ? `This code expires at ${expires}.` : "This code expires shortly.";

  const text = [
    "Use this code to finish signing in:",
    "",
    code,
    "",
    expiryLineText,
    "If you did not request this code, you can safely ignore this email.",
  ].join("\n");

  const html = htmlShell(
    "Finish signing in",
    [
      '<p style="margin:0 0 16px;font-size:14px;">Use this code to finish signing in:</p>',
      `<p style="margin:0 0 16px;font-size:28px;font-weight:700;letter-spacing:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(code)}</p>`,
      `<p style="margin:0 0 8px;font-size:13px;color:#6b6b80;">${escapeHtml(expiryLineText)}</p>`,
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If you did not request this code, you can safely ignore this email.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated security email."),
  );

  return { subject, html, text };
};

const renderInvitationCreated: TemplateRenderer = (data, opts) => {
  const role = str(data, "role");
  const expires = formatTimestamp(str(data, "expiresAt"));
  const brand = opts.brandName ?? "";
  const subject = brand
    ? `You have been invited to an organization on ${brand}`
    : "You have been invited to an organization";
  const roleLineText = role
    ? `You have been invited to join an organization as ${role}.`
    : "You have been invited to join an organization.";
  const expiryLineText = expires ? `The invitation expires at ${expires}.` : "";

  const text = [
    roleLineText,
    expiryLineText,
    "Sign in with this email address to view and accept the invitation.",
    "If you were not expecting this invitation, you can safely ignore this email.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");

  const html = htmlShell(
    "You have been invited",
    [
      `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(roleLineText)}</p>`,
      expiryLineText
        ? `<p style="margin:0 0 16px;font-size:13px;color:#6b6b80;">${escapeHtml(expiryLineText)}</p>`
        : "",
      '<p style="margin:0 0 8px;font-size:14px;">Sign in with this email address to view and accept the invitation.</p>',
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If you were not expecting this invitation, you can safely ignore this email.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );

  return { subject, html, text };
};

const renderInvitationAccepted: TemplateRenderer = (data, opts) => {
  const role = str(data, "role");
  const brand = opts.brandName ?? "";
  const subject = brand ? `You have joined an organization on ${brand}` : "You have joined an organization";
  const bodyLineText = role
    ? `Your invitation was accepted and you are now a member with the ${role} role.`
    : "Your invitation was accepted and you are now a member of the organization.";

  const text = [
    bodyLineText,
    "If this was not you, contact your organization administrator.",
  ].join("\n\n");

  const html = htmlShell(
    "Welcome aboard",
    [
      `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(bodyLineText)}</p>`,
      '<p style="margin:0;font-size:13px;color:#6b6b80;">If this was not you, contact your organization administrator.</p>',
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );

  return { subject, html, text };
};

// ── Meterwise (MW2): ledger-worker's alerts ─────────────────
// templateData carries only the customer's own attribution strings (tenant,
// feature, end-user), amounts as exact decimal strings and ISO timestamps.
// Never a credential: the ledger stores none.

const ANOMALY_LINES: Record<string, (d: TemplateData) => string> = {
  runaway_loop: (d) =>
    `Tenant "${str(d, "tenant")}"${str(d, "feature") ? `, feature "${str(d, "feature")}"` : ""} made ${str(d, "events")} LLM calls in the hour before ${formatTimestamp(str(d, "windowEnd"))}, over 10 times its usual rate (7-day median ${str(d, "baselineMedian")} an hour). This looks like a runaway loop.`,
  abusive_user: (d) =>
    `End-user "${str(d, "user")}" of tenant "${str(d, "tenant")}" spent $${str(d, "userCostUsd")} of the tenant's $${str(d, "tenantCostUsd")} in the hour before ${formatTimestamp(str(d, "windowEnd"))}.`,
};

const renderLedgerAnomaly: TemplateRenderer = (data, opts) => {
  const brand = opts.brandName ?? "";
  const kind = str(data, "kind");
  const line = (ANOMALY_LINES[kind] ?? (() => `An unusual pattern of LLM usage was detected for tenant "${str(data, "tenant")}".`))(data);
  const subject = `${brand ? `${brand}: ` : ""}LLM usage anomaly for tenant ${str(data, "tenant")}`;
  const follow = "Check the Costs page for the calls behind it. You get one email per anomaly per window.";
  const text = [line, follow].join("\n\n");
  const html = htmlShell(
    "LLM usage anomaly",
    [
      `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(line)}</p>`,
      `<p style="margin:0;font-size:13px;color:#6b6b80;">${escapeHtml(follow)}</p>`,
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );
  return { subject, html, text };
};

const renderLedgerBudgetCrossed: TemplateRenderer = (data, opts) => {
  const brand = opts.brandName ?? "";
  const level = str(data, "level") === "hard" ? "hard" : "soft";
  const line = `Tenant "${str(data, "tenant")}" has spent $${str(data, "spentUsd")} on LLM calls in ${str(data, "period")}, reaching its ${level} budget of $${str(data, "limitUsd")}.`;
  const effect =
    level === "hard"
      ? "Pre-flight checks for this tenant now answer deny until the month ends or the budget is raised."
      : "Pre-flight checks for this tenant now answer warn, or downgrade where a cheaper model is mapped.";
  const subject = `${brand ? `${brand}: ` : ""}Tenant ${str(data, "tenant")} reached its ${level} LLM budget`;
  const text = [line, effect].join("\n\n");
  const html = htmlShell(
    `${level === "hard" ? "Hard" : "Soft"} budget reached`,
    [
      `<p style="margin:0 0 16px;font-size:14px;">${escapeHtml(line)}</p>`,
      `<p style="margin:0;font-size:13px;color:#6b6b80;">${escapeHtml(effect)}</p>`,
    ].join(""),
    escapeHtml(brand ? `Sent by ${brand}` : "This is an automated email."),
  );
  return { subject, html, text };
};

const TEMPLATES: Record<string, TemplateRenderer> = {
  "auth.magic_link": renderMagicLink,
  "invitation.created": renderInvitationCreated,
  "invitation.accepted": renderInvitationAccepted,
  "ledger.anomaly.detected": renderLedgerAnomaly,
  "ledger.budget.crossed": renderLedgerBudgetCrossed,
};

/**
 * Render the email for a template key, or null when the key has no
 * registered template. Callers (the provider adapters) MUST treat null as a
 * bounded send failure — never deliver an empty or generic body.
 */
export function renderEmailTemplate(
  templateKey: string,
  templateData: TemplateData,
  opts: TemplateRenderOptions = {},
): RenderedEmail | null {
  const renderer = TEMPLATES[templateKey];
  if (!renderer) return null;
  return renderer(templateData, opts);
}
