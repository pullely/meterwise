"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { Check, Loader2 } from "lucide-react";
import type { GetBillingSummaryResponse, ListPlansResponse, PublicPlan } from "@saas/contracts/billing";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/toast";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import {
  formatPlanPrice,
  orderedPlans,
  planChangeAction,
  planFeatureLines,
  pollForPlanChange,
  type PlanChangeAction,
} from "./plan-actions";
import { SALES_EMAIL } from "@/lib/app-config";

const POLL_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Polar-style "Change plan" screen: a grid of plan cards (current marked
 * "Current"), select one → confirm → run the matching action (embedded
 * checkout for a first purchase, native change for a plan switch, cancel for a
 * move to Free, contact-sales for Enterprise). On success it polls until the new
 * plan lands, then returns to the billing page.
 */
export function ChangePlanCards({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const router = useRouter();
  const { client } = useSession();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { resolvedTheme } = useTheme();

  const plansQ = useApiQuery<ListPlansResponse>(["billing", "plans", orgId], () =>
    wrap(() => client.billing.listPlans(orgId)),
  );
  const summaryQ = useApiQuery<GetBillingSummaryResponse>(qk.billingSummary(orgId), () =>
    wrap(() => client.billing.getSummary(orgId)),
  );

  const [selected, setSelected] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [statusMsg, setStatusMsg] = React.useState("");

  const billingPath = `/orgs/${orgSlug}/settings/billing`;
  const loading = plansQ.loading || summaryQ.loading;
  const currentCode = summaryQ.data?.plan?.code ?? "free";
  const manageable = currentCode !== "free" && !!summaryQ.data?.activeSubscription?.providerSubscriptionId;
  const plans = orderedPlans(plansQ.data?.plans ?? []);
  const selectedPlan = plans.find((p) => p.code === selected) ?? null;
  const action: PlanChangeAction | null = selectedPlan
    ? planChangeAction({ target: selectedPlan, currentCode, manageable })
    : null;

  const goBack = React.useCallback(() => router.push(billingPath), [router, billingPath]);

  const refreshAndReturn = React.useCallback(
    async (fromCode: string) => {
      setStatusMsg("Finalizing your plan change…");
      await pollForPlanChange({
        fromPlanCode: fromCode,
        attempts: POLL_ATTEMPTS,
        intervalMs: POLL_INTERVAL_MS,
        sleep,
        fetchPlanCode: async () => {
          const r = await wrap(() => client.billing.getSummary(orgId));
          return r.ok ? (r.data.plan?.code ?? null) : fromCode;
        },
      });
      void qc.invalidateQueries({ queryKey: qk.billingSummary(orgId) });
      void qc.invalidateQueries({ queryKey: qk.entitlements(orgId) });
      void qc.invalidateQueries({ queryKey: qk.invoices(orgId) });
      void qc.invalidateQueries({ queryKey: ["billing", "plans", orgId] });
      toast({ kind: "success", title: "Plan updated", description: "Your subscription has been updated." });
      goBack();
    },
    [client, orgId, qc, toast, goBack],
  );

  const onConfirm = React.useCallback(async () => {
    if (!selectedPlan || !action) return;
    setConfirmOpen(false);

    if (action === "contact") {
      window.location.href = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent("Enterprise plan enquiry")}`;
      return;
    }

    setBusy(true);
    setStatusMsg("Starting your plan change…");

    if (action === "change") {
      const r = await wrap(() => client.billing.changePlan(orgId, { planCode: selectedPlan.code }));
      if (!r.ok) {
        setBusy(false);
        toast({ kind: "error", title: "Could not change plan", description: r.error.message });
        return;
      }
      await refreshAndReturn(currentCode);
      return;
    }

    if (action === "cancel") {
      const r = await wrap(() => client.billing.cancelSubscription(orgId));
      if (!r.ok) {
        setBusy(false);
        toast({ kind: "error", title: "Could not cancel", description: r.error.message });
        return;
      }
      await refreshAndReturn(currentCode);
      return;
    }

    // checkout (first purchase) → embedded overlay, fall back to redirect.
    const r = await wrap(() =>
      client.billing.createCheckout(orgId, {
        planCode: selectedPlan.code,
        embedOrigin: window.location.origin,
        returnPath: `${billingPath}?checkout=complete`,
      }),
    );
    if (!r.ok) {
      setBusy(false);
      toast({ kind: "error", title: "Could not start checkout", description: r.error.message });
      return;
    }
    if (r.data.mode === "portal") {
      window.location.assign(r.data.checkoutUrl);
      return;
    }
    try {
      const { PolarEmbedCheckout } = await import("@polar-sh/checkout/embed");
      const theme = resolvedTheme === "light" ? "light" : "dark";
      const checkout = await PolarEmbedCheckout.create(r.data.checkoutUrl, { theme });
      checkout.addEventListener("success", () => {
        checkout.close();
        void refreshAndReturn(currentCode);
      });
      checkout.addEventListener("close", () => setBusy(false));
    } catch {
      window.location.assign(r.data.checkoutUrl);
    }
  }, [selectedPlan, action, client, orgId, currentCode, billingPath, resolvedTheme, refreshAndReturn, toast]);

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-72 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (busy) {
    return (
      <div role="status" className="flex items-center gap-2 rounded-md border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {statusMsg || "Working…"}
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((p) => {
          const isCurrent = p.code === currentCode;
          const isSelected = p.code === selected;
          return (
            <button
              key={p.code}
              type="button"
              disabled={isCurrent}
              onClick={() => setSelected(p.code)}
              className={[
                "flex flex-col rounded-lg border p-5 text-left transition-colors",
                isCurrent ? "cursor-default opacity-80" : "hover:border-foreground/30",
                isSelected ? "border-primary ring-1 ring-primary" : "border-border",
              ].join(" ")}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold">{p.name}</span>
                {isCurrent ? (
                  <Badge variant="secondary">Current</Badge>
                ) : p.code === "business" ? (
                  <Badge variant="success">Popular</Badge>
                ) : null}
              </div>
              {p.description ? <p className="mt-1 text-sm text-muted-foreground">{p.description}</p> : null}
              <div className="mt-4 text-2xl font-semibold">{priceLabel(p)}</div>
              <ul className="mt-4 space-y-1.5">
                {planFeatureLines(p.code).map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                    {f}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      <div className="mt-6 flex items-center justify-end gap-3">
        <Button variant="ghost" onClick={goBack}>Cancel</Button>
        <Button disabled={!selectedPlan} onClick={() => setConfirmOpen(true)}>
          {continueLabel(action)}
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmTitle(action, selectedPlan)}</DialogTitle>
            <DialogDescription>{confirmBody(action, selectedPlan)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button onClick={() => void onConfirm()}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function priceLabel(p: PublicPlan): string {
  if (p.billingInterval === "none") return "Custom";
  if (!p.priceAmountCents) return "Free";
  return formatPlanPrice(p);
}

function continueLabel(action: PlanChangeAction | null): string {
  if (action === "cancel") return "Continue";
  if (action === "contact") return "Contact sales";
  return "Continue to checkout";
}

function confirmTitle(action: PlanChangeAction | null, plan: PublicPlan | null): string {
  if (action === "cancel") return "Cancel subscription";
  if (action === "contact") return "Contact sales";
  return `Switch to ${plan?.name ?? "plan"}`;
}

function confirmBody(action: PlanChangeAction | null, plan: PublicPlan | null): string {
  const name = plan?.name ?? "this plan";
  if (action === "cancel") return "You'll move to the Free plan. Paid features will be removed.";
  if (action === "contact") return `We'll open your email to contact our sales team about ${name}.`;
  if (action === "change") return `Your plan will switch to ${name} and your billing is adjusted (prorated) automatically.`;
  return `You'll complete checkout to add a payment method and start your ${name} subscription.`;
}
