/**
 * Pure (no-React) model for the guided create-organization flow, kept separate
 * so step/labels/routing logic is unit-testable without a DOM — the same split
 * the billing UI uses (`plan-actions.ts`).
 *
 * "parent" mode is the account's first organization: it owns billing, so the
 * flow includes a plan step. "child" mode is any additional organization:
 * billing rolls up to the account's billing parent (MO2), so the plan step is
 * replaced by a starting-point step (connect Git / clone a template).
 */

export type CreateOrgMode = "parent" | "child";

export type StepId = "details" | "plan" | "source" | "review";

export interface StepDef {
  id: StepId;
  label: string;
  description: string;
}

/** The wizard's steps for a given mode. */
export function flowSteps(mode: CreateOrgMode): StepDef[] {
  return [
    { id: "details", label: "Organization", description: "Name and URL" },
    mode === "parent"
      ? { id: "plan", label: "Plan", description: "Pick your pricing tier" }
      : { id: "source", label: "Starting point", description: "Import or start fresh" },
    { id: "review", label: "Review", description: "Confirm and create" },
  ];
}

// ---------------------------------------------------------------------------
// Plans (parent mode)
// ---------------------------------------------------------------------------

export interface PlanOption {
  /** Stable billing plan code — checkout runs against the real plan after create. */
  code: string;
  name: string;
  tagline: string;
  /** Display price, e.g. "$20". */
  price: string;
  /** Display billing period suffix, e.g. "/mo". */
  per?: string;
  popular?: boolean;
  /** Contact-sales tier with no self-serve checkout. */
  contact?: boolean;
}

/**
 * Display catalog for the plan step. It runs before the organization (and
 * therefore its org-scoped `/billing/plans` surface) exists, so the cards
 * render from this catalog; the selected `code` is what drives the real
 * checkout once the organization has been created.
 */
export const PLAN_OPTIONS: PlanOption[] = [
  {
    code: "free",
    name: "Free",
    tagline: "For personal projects and evaluation",
    price: "$0",
    per: "/mo",
  },
  {
    code: "pro",
    name: "Pro",
    tagline: "For small teams shipping to production",
    price: "$20",
    per: "/mo",
  },
  {
    code: "business",
    name: "Business",
    tagline: "For companies running multiple teams",
    price: "$100",
    per: "/mo",
    popular: true,
  },
  {
    code: "enterprise",
    name: "Enterprise",
    tagline: "Security, control, and support at scale",
    price: "Custom",
    contact: true,
  },
];

// ---------------------------------------------------------------------------
// Starting point (child mode)
// ---------------------------------------------------------------------------

export type GitProviderId = "github" | "gitlab" | "bitbucket";

/** What the new (child) organization starts from. */
export type SourceChoice =
  | { kind: "scratch" }
  | { kind: "git"; provider: GitProviderId }
  | { kind: "template"; templateId: string };

export interface GitProviderDef {
  id: GitProviderId;
  name: string;
  /** Only GitHub is wired up today (org-scoped GitHub App install). */
  available: boolean;
  note: string;
}

export const GIT_PROVIDERS: GitProviderDef[] = [
  {
    id: "github",
    name: "Continue with GitHub",
    available: true,
    note: "Install the GitHub App right after the organization is created.",
  },
  {
    id: "gitlab",
    name: "Continue with GitLab",
    available: false,
    note: "Import projects from GitLab groups and repositories.",
  },
  {
    id: "bitbucket",
    name: "Continue with Bitbucket",
    available: false,
    note: "Import projects from Bitbucket workspaces.",
  },
];

export interface TemplateDef {
  id: string;
  name: string;
  description: string;
}

export const TEMPLATES: TemplateDef[] = [
  {
    id: "web-app",
    name: "Web App Starter",
    description: "Next.js front end wired to org-scoped auth and projects.",
  },
  {
    id: "api-service",
    name: "API Service",
    description: "Typed REST service with environments and config baked in.",
  },
  {
    id: "worker",
    name: "Background Worker",
    description: "Queue-driven worker with metering and webhooks.",
  },
  {
    id: "ai-chatbot",
    name: "AI Chatbot",
    description: "Streaming chat app with usage-based billing hooks.",
  },
];

export function providerShortName(id: GitProviderId): string {
  return id === "github" ? "GitHub" : id === "gitlab" ? "GitLab" : "Bitbucket";
}

/** Short human label for the review step. */
export function sourceSummary(choice: SourceChoice): string {
  if (choice.kind === "git") return `Import from ${providerShortName(choice.provider)}`;
  if (choice.kind === "template") {
    const t = TEMPLATES.find((x) => x.id === choice.templateId);
    return `Template: ${t?.name ?? choice.templateId}`;
  }
  return "Start from scratch";
}

// ---------------------------------------------------------------------------
// Submit semantics
// ---------------------------------------------------------------------------

/** The primary button label on the review step, naming the hand-off it triggers. */
export function createButtonLabel(
  mode: CreateOrgMode,
  plan: PlanOption,
  source: SourceChoice,
): string {
  if (mode === "parent" && plan.contact) return "Create & contact sales";
  if (mode === "parent" && plan.code !== "free") return "Create & continue to checkout";
  if (mode === "child" && source.kind === "git" && source.provider === "github") {
    return "Create & connect GitHub";
  }
  return "Create organization";
}

/**
 * Where the console routes after a successful create (when it does not leave
 * for hosted checkout): the new org's Integrations page when the buyer chose
 * the GitHub starting point, else the new org's projects dashboard.
 */
export function postCreatePath(mode: CreateOrgMode, source: SourceChoice, orgSlug: string): string {
  if (mode === "child" && source.kind === "git" && source.provider === "github") {
    return `/orgs/${orgSlug}/settings/integrations`;
  }
  return `/orgs/${orgSlug}/projects`;
}
