"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { ListPaymentMethodsResponse } from "@saas/contracts/billing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/toast";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { hasManageableSubscription, pollForPlanChange } from "./plan-actions";

const PORTAL_KEY = "__portal__";
const POLL_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * "Manage plan" card on the billing page (Polar-style). Plan up/down/cancel all
 * happen on the dedicated change-plan cards page (the "Change plan" button); this
 * card surfaces that entry point plus the payment method (the one PCI deep-link)
 * and the card on file. It also self-heals an unlinked paid plan (reconcile) and
 * finalizes a returning hosted checkout (`?checkout=complete`).
 */
export function BillingActions({
  orgId,
  activePlanCode,
  providerManaged,
}: {
  orgId: string;
  activePlanCode: string | null;
  /** Whether the active subscription is backed by a provider subscription. */
  providerManaged: boolean;
}) {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  const { client } = useSession();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [reconciling, setReconciling] = React.useState(false);
  const [finalizing, setFinalizing] = React.useState(false);

  const isPaid = hasManageableSubscription(activePlanCode);
  const manageable = isPaid && providerManaged;
  const unmanagedPaid = isPaid && !providerManaged;

  const pm = useApiQuery<ListPaymentMethodsResponse>(
    ["billing", "paymentMethods", orgId],
    () => wrap(() => client.billing.listPaymentMethods(orgId)),
    { enabled: manageable },
  );
  const card = pm.data?.paymentMethods?.[0] ?? null;

  const refreshBilling = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: qk.billingSummary(orgId) });
    void qc.invalidateQueries({ queryKey: qk.entitlements(orgId) });
    void qc.invalidateQueries({ queryKey: qk.invoices(orgId) });
    void qc.invalidateQueries({ queryKey: ["billing", "plans", orgId] });
  }, [qc, orgId]);

  // Self-heal a paid plan with no local provider link (missed/dropped webhook):
  // reconcile from the provider once; on success refresh so the actions appear.
  const reconcileTried = React.useRef(false);
  React.useEffect(() => {
    if (!unmanagedPaid || reconcileTried.current) return;
    reconcileTried.current = true;
    setReconciling(true);
    void (async () => {
      const r = await wrap(() => client.billing.reconcile(orgId));
      if (r.ok && r.data.reconciled) {
        refreshBilling();
        setTimeout(() => setReconciling(false), 8000);
      } else {
        setReconciling(false);
      }
    })();
  }, [unmanagedPaid, client, orgId, refreshBilling]);

  // Returning from a hosted (non-embedded) checkout: poll until the plan lands.
  const handledReturn = React.useRef(false);
  React.useEffect(() => {
    if (handledReturn.current) return;
    const p = new URLSearchParams(window.location.search);
    if (p.get("checkout") !== "complete") return;
    handledReturn.current = true;
    p.delete("checkout");
    const qs = p.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    void (async () => {
      setFinalizing(true);
      await pollForPlanChange({
        fromPlanCode: "free",
        attempts: POLL_ATTEMPTS,
        intervalMs: POLL_INTERVAL_MS,
        sleep,
        fetchPlanCode: async () => {
          const r = await wrap(() => client.billing.getSummary(orgId));
          return r.ok ? (r.data.plan?.code ?? null) : null;
        },
      });
      refreshBilling();
      setFinalizing(false);
      toast({ kind: "success", title: "Upgrade complete", description: "Your new plan is active." });
    })();
  }, [client, orgId, refreshBilling, toast]);

  // Updating the card is the one PCI-gated action — a brief deep-link to the
  // hosted portal (card details never touch our servers).
  const openPortal = React.useCallback(async () => {
    setBusy(PORTAL_KEY);
    const r = await wrap(() => client.billing.createPortalSession(orgId));
    setBusy(null);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not open billing portal", description: r.error.message });
      return;
    }
    window.location.assign(r.data.portalUrl);
  }, [client, orgId, toast]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Manage plan</CardTitle>
        <CardDescription>Change your plan or update your payment method.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {finalizing ? (
          <div role="status" className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Finalizing your upgrade…
          </div>
        ) : unmanagedPaid && reconciling ? (
          <div className="flex flex-wrap items-center gap-3" aria-busy="true">
            <Skeleton className="h-9 w-32 rounded-md" />
            <Skeleton className="h-9 w-44 rounded-md" />
          </div>
        ) : unmanagedPaid ? (
          <p className="text-sm text-muted-foreground">
            This plan was assigned by an administrator and isn’t managed through self-serve billing.
            Contact support to change or cancel it.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild>
              <Link href={`/orgs/${slug}/settings/billing/change-plan`}>Change plan</Link>
            </Button>
            {manageable ? (
              <span className="flex items-center gap-2">
                {card ? (
                  <span className="text-sm text-muted-foreground">
                    {capitalize(card.brand)} •••• {card.last4}
                    <span className="text-muted-foreground/70">
                      {" "}· exp {String(card.expMonth).padStart(2, "0")}/{String(card.expYear).slice(-2)}
                    </span>
                  </span>
                ) : null}
                <Button
                  variant="outline"
                  loading={busy === PORTAL_KEY}
                  disabled={busy !== null}
                  onClick={() => void openPortal()}
                >
                  {card ? "Update payment method" : "Add payment method"}
                </Button>
              </span>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
