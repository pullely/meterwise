"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Building2, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PreconditionInsight } from "@/components/precondition/insight";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";
import { qk } from "@/lib/query";
import { slugify } from "@/lib/slug";
import { cn } from "@/lib/cn";
import { SALES_EMAIL } from "@/lib/app-config";
import { PlanPicker } from "./plan-picker";
import { SourcePicker } from "./source-picker";
import {
  PLAN_OPTIONS,
  createButtonLabel,
  flowSteps,
  postCreatePath,
  sourceSummary,
  type CreateOrgMode,
  type SourceChoice,
  type StepDef,
} from "./create-org-model";

/**
 * Guided, Vercel-style create-organization flow. Step composition, labels, and
 * post-create routing live in `create-org-model.ts` (pure, unit-tested); this
 * component owns the form state, the stepper chrome, and the submit hand-offs
 * (checkout for paid parent plans, GitHub App install for the GitHub starting
 * point).
 *
 * Two surfaces render it: the in-shell `/orgs/new` page ("page" variant, child
 * orgs) and the mandatory first-run `/onboarding` page ("onboarding" variant).
 * Onboarding has no org to go back to, so the picker back-link and the
 * first-step Cancel are dropped there.
 */

export type { CreateOrgMode };

export type CreateOrgVariant = "page" | "onboarding";

export interface BillingParentRef {
  id: string;
  name: string;
  slug: string;
}

const SLUG_RE = /^[a-z0-9-]*$/;

export function CreateOrgFlow({
  mode,
  billingParent,
  variant = "page",
}: {
  mode: CreateOrgMode;
  billingParent: BillingParentRef | null;
  variant?: CreateOrgVariant;
}) {
  const router = useRouter();
  const { client } = useSession();
  const { toast } = useToast();
  const qc = useQueryClient();

  const steps = React.useMemo(() => flowSteps(mode), [mode]);

  const [stepIndex, setStepIndex] = React.useState(0);
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [planCode, setPlanCode] = React.useState("free");
  const [source, setSource] = React.useState<SourceChoice>({ kind: "scratch" });
  const [submitting, setSubmitting] = React.useState(false);
  const [precondition, setPrecondition] = React.useState<ApiErrorBody | null>(null);

  const step = steps[stepIndex]!;
  const isLast = stepIndex === steps.length - 1;
  const plan = PLAN_OPTIONS.find((p) => p.code === planCode) ?? PLAN_OPTIONS[0]!;

  const trimmedName = name.trim();
  const nameError =
    trimmedName.length > 0 && trimmedName.length < 2 ? "Name must be at least 2 characters" : null;
  const slugError = !SLUG_RE.test(slug) ? "Lowercase letters, digits, hyphens" : null;
  const detailsValid = trimmedName.length >= 2 && trimmedName.length <= 64 && !slugError;
  const canContinue = step.id === "details" ? detailsValid : true;

  const onNameChange = (v: string) => {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  };

  const back = () => {
    if (stepIndex === 0) {
      router.push("/orgs");
      return;
    }
    setStepIndex((i) => i - 1);
  };

  // Multi-org gating (MO2) is checked against the account's billing parent, so
  // the paywall's "Upgrade plan" CTA starts a Business checkout for that org —
  // the same shape the orgs list page uses.
  const onUpgrade = React.useCallback(async () => {
    if (!billingParent) return;
    const r = await wrap(() =>
      client.billing.createCheckout(billingParent.id, { planCode: "business" }),
    );
    if (!r.ok) {
      toast({ kind: "error", title: "Could not start checkout", description: r.error.message });
      return;
    }
    window.location.assign(r.data.checkoutUrl);
  }, [billingParent, client, toast]);

  const onCreate = async () => {
    setPrecondition(null);
    setSubmitting(true);
    const payload: { name: string; slug?: string } = { name: trimmedName };
    if (slug) payload.slug = slug;
    const r = await wrap(async () => (await client.organizations.create(payload)).organization);
    if (!r.ok) {
      setSubmitting(false);
      if (r.error.code === "precondition_failed") {
        setPrecondition(r.error);
      } else {
        toast({
          kind: "error",
          title: "Could not create organization",
          description: r.error.message,
        });
      }
      return;
    }
    const org = r.data;
    void qc.invalidateQueries({ queryKey: qk.orgs() });

    if (mode === "parent" && plan.contact) {
      window.location.href = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent(
        `Enterprise plan enquiry for ${org.name}`,
      )}`;
    } else if (mode === "parent" && plan.code !== "free") {
      const c = await wrap(() =>
        client.billing.createCheckout(org.id, {
          planCode: plan.code,
          returnPath: `/orgs/${org.slug}/settings/billing?checkout=complete`,
        }),
      );
      if (c.ok) {
        // Leaving the app for hosted checkout; keep the busy state up.
        window.location.assign(c.data.checkoutUrl);
        return;
      }
      toast({
        kind: "warning",
        title: "Organization created — checkout unavailable",
        description: "You can upgrade anytime from Settings → Billing.",
      });
    }

    toast({ kind: "success", title: `${org.name} created` });
    router.push(postCreatePath(mode, source, org.slug));
  };

  const createLabel = createButtonLabel(mode, plan, source);

  return (
    <div className="mx-auto max-w-5xl">
      {variant === "page" && (
        <Link
          href="/orgs"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Organizations
        </Link>
      )}

      <header className="mt-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {mode === "parent" ? "Create your organization" : "Add a new organization"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "parent"
            ? "An organization is your tenant — it owns projects, members, and billing. You need one to use the console."
            : "Another tenant under your account — its billing rolls up to your parent organization."}
        </p>
      </header>

      {/* Mobile progress (the vertical rail collapses below md). */}
      <div className="mt-6 md:hidden">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{step.label}</span>
          <span>
            Step {stepIndex + 1} of {steps.length}
          </span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${((stepIndex + 1) / steps.length) * 100}%` }}
          />
        </div>
      </div>

      <div className="mt-8 flex gap-10">
        <Stepper steps={steps} current={stepIndex} />

        <div className="min-w-0 flex-1">
          {precondition && (
            <div className="mb-6">
              <PreconditionInsight
                error={precondition}
                resource="organization"
                onUpgrade={() => void onUpgrade()}
                onDismiss={() => setPrecondition(null)}
              />
            </div>
          )}

          {step.id === "details" && (
            <DetailsStep
              mode={mode}
              billingParent={billingParent}
              name={name}
              onNameChange={onNameChange}
              nameError={nameError}
              slug={slug}
              onSlugChange={(v) => {
                setSlugTouched(true);
                setSlug(v);
              }}
              slugError={slugError}
            />
          )}

          {step.id === "plan" && (
            <section className="space-y-6">
              <StepHeading
                title="Choose your plan"
                subtitle="Start free and upgrade when you're ready — paid plans go through secure checkout after the organization is created."
              />
              <PlanPicker value={planCode} onChange={setPlanCode} />
              <p className="text-xs text-muted-foreground">
                You can change plans anytime in Settings → Billing.
              </p>
            </section>
          )}

          {step.id === "source" && (
            <section className="space-y-6">
              <StepHeading
                title="Pick a starting point"
                subtitle="Connect a Git provider, clone a template, or start with an empty organization."
              />
              <SourcePicker value={source} onChange={setSource} />
            </section>
          )}

          {step.id === "review" && (
            <ReviewStep
              mode={mode}
              billingParent={billingParent}
              name={trimmedName}
              slug={slug}
              plan={plan}
              source={source}
            />
          )}

          <footer className="mt-8 flex items-center justify-between gap-3 border-t pt-5">
            {stepIndex === 0 && variant === "onboarding" ? (
              // Onboarding is mandatory — there is no org-less view to cancel
              // back to, so keep the slot for layout but render nothing.
              <span />
            ) : (
              <Button variant="ghost" onClick={back} disabled={submitting}>
                {stepIndex === 0 ? (
                  "Cancel"
                ) : (
                  <>
                    <ArrowLeft className="h-4 w-4" />
                    Back
                  </>
                )}
              </Button>
            )}
            {isLast ? (
              <Button onClick={() => void onCreate()} loading={submitting}>
                {createLabel}
              </Button>
            ) : (
              <Button onClick={() => setStepIndex((i) => i + 1)} disabled={!canContinue}>
                Continue
                <ArrowRight className="h-4 w-4" />
              </Button>
            )}
          </footer>
        </div>
      </div>
    </div>
  );
}

function Stepper({ steps, current }: { steps: StepDef[]; current: number }) {
  return (
    <ol className="hidden w-56 shrink-0 md:block" aria-label="Setup steps">
      {steps.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={s.id} className="relative pb-8 last:pb-0">
            {i < steps.length - 1 && (
              <span
                className={cn(
                  "absolute left-4 top-9 h-[calc(100%-2.25rem)] w-px",
                  i < current ? "bg-primary" : "bg-border",
                )}
                aria-hidden
              />
            )}
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  "grid h-8 w-8 shrink-0 place-items-center rounded-full border text-sm font-medium transition-colors",
                  state === "done" && "border-primary bg-primary text-primary-foreground",
                  state === "current" && "border-primary text-primary",
                  state === "todo" && "border-border text-muted-foreground",
                )}
                aria-current={state === "current" ? "step" : undefined}
              >
                {state === "done" ? <Check className="h-4 w-4" /> : i + 1}
              </span>
              <div className="pt-1">
                <div className={cn("text-sm font-medium", state === "todo" && "text-muted-foreground")}>
                  {s.label}
                </div>
                <div className="text-xs text-muted-foreground">{s.description}</div>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

function DetailsStep({
  mode,
  billingParent,
  name,
  onNameChange,
  nameError,
  slug,
  onSlugChange,
  slugError,
}: {
  mode: CreateOrgMode;
  billingParent: BillingParentRef | null;
  name: string;
  onNameChange: (v: string) => void;
  nameError: string | null;
  slug: string;
  onSlugChange: (v: string) => void;
  slugError: string | null;
}) {
  return (
    <section className="space-y-6">
      <StepHeading title="Organization details" subtitle="Name your organization and claim its URL." />

      {mode === "child" && billingParent && (
        <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
          <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p>
            <span className="font-medium">Part of your {billingParent.name} account.</span>{" "}
            <span className="text-muted-foreground">
              Billing rolls up to {billingParent.name}; plan and limits come from your account plan.
            </span>
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="org-name">Name</Label>
        <Input
          id="org-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Acme Inc."
          maxLength={64}
          autoFocus
        />
        {nameError ? <p className="text-xs text-destructive">{nameError}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="org-slug">Slug</Label>
        <div className="flex rounded-md shadow-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background">
          <span className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-muted px-3 text-sm text-muted-foreground">
            /orgs/
          </span>
          <input
            id="org-slug"
            value={slug}
            onChange={(e) => onSlugChange(e.target.value)}
            placeholder="acme"
            maxLength={48}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-11 w-full rounded-r-md border border-input bg-background px-3 text-base placeholder:text-muted-foreground focus-visible:outline-none sm:h-9 sm:text-sm"
          />
        </div>
        <p className={cn("text-xs", slugError ? "text-destructive" : "text-muted-foreground")}>
          {slugError ?? "Auto-filled from the name; edit to override."}
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Preview
        </div>
        <div className="mt-3 flex items-center gap-3">
          <OrgAvatar name={name} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{name.trim() || "Your organization"}</div>
            <div className="truncate text-xs text-muted-foreground">/orgs/{slug || "your-org"}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ReviewStep({
  mode,
  billingParent,
  name,
  slug,
  plan,
  source,
}: {
  mode: CreateOrgMode;
  billingParent: BillingParentRef | null;
  name: string;
  slug: string;
  plan: (typeof PLAN_OPTIONS)[number];
  source: SourceChoice;
}) {
  const nextSteps: string[] = [`We create ${name || "your organization"} and make you its owner.`];
  if (mode === "parent") {
    if (plan.contact) {
      nextSteps.push("We open an email to our sales team about Enterprise pricing.");
    } else if (plan.code !== "free") {
      nextSteps.push(`You're taken to secure checkout to start your ${plan.name} subscription.`);
    } else {
      nextSteps.push("You land on your new dashboard, ready to create projects.");
    }
  } else if (source.kind === "git" && source.provider === "github") {
    nextSteps.push("You're taken to Integrations to install the GitHub App.");
  } else {
    nextSteps.push("You land on your new dashboard, ready to create projects.");
  }

  return (
    <section className="space-y-6">
      <StepHeading title="Review & create" subtitle="Double-check the details — most settings can be changed later." />

      <dl className="divide-y rounded-lg border bg-card">
        <ReviewRow label="Organization">
          <div className="flex items-center gap-3">
            <OrgAvatar name={name} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{name}</div>
              <div className="truncate text-xs text-muted-foreground">/orgs/{slug || slugify(name) || "your-org"}</div>
            </div>
          </div>
        </ReviewRow>
        <ReviewRow label="Type">
          {mode === "parent" ? (
            <span className="text-sm">
              Parent organization{" "}
              <span className="text-muted-foreground">— owns billing for your account</span>
            </span>
          ) : (
            <span className="text-sm">
              Child organization{" "}
              <span className="text-muted-foreground">
                — billing rolls up to {billingParent?.name ?? "your parent organization"}
              </span>
            </span>
          )}
        </ReviewRow>
        {mode === "parent" ? (
          <ReviewRow label="Plan">
            <span className="text-sm">
              {plan.name}{" "}
              <span className="text-muted-foreground">
                {plan.contact ? "— custom pricing" : `— ${plan.price}${plan.per ?? ""}`}
              </span>
            </span>
          </ReviewRow>
        ) : (
          <ReviewRow label="Starting point">
            <span className="text-sm">{sourceSummary(source)}</span>
          </ReviewRow>
        )}
      </dl>

      <div className="rounded-lg border bg-muted/40 p-4">
        <div className="text-sm font-medium">What happens next</div>
        <ul className="mt-2 space-y-1.5">
          {nextSteps.map((s) => (
            <li key={s} className="flex items-start gap-2 text-sm text-muted-foreground">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              {s}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ReviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center">
      <dt className="w-36 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function OrgAvatar({ name }: { name: string }) {
  return (
    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-gradient-to-br from-primary/40 to-primary/10 text-sm font-semibold">
      {(name.trim() || "A").charAt(0).toUpperCase()}
    </div>
  );
}
