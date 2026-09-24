"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Receipt, ExternalLink } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { PreconditionInsight } from "@/components/precondition/insight";
import { BillingActions } from "@/components/billing/billing-actions";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

export default function BillingPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const summary = useApiQuery(qk.billingSummary(orgId), () => wrap(() => client.billing.getSummary(orgId)));
  const ents = useApiQuery(qk.entitlements(orgId), () => wrap(() => client.billing.getEntitlements(orgId)));
  const inv = useApiQuery(qk.invoices(orgId), () => wrap(() => client.billing.listInvoices(orgId)));

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">Plan, entitlements, and invoices for this organization.</p>
      </header>

      {/* Plan / customer */}
      {summary.loading ? (
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-16 w-full" />
          </CardContent>
        </Card>
      ) : summary.error ? (
        summary.error.code === "precondition_failed" ? (
          <PreconditionInsight
            error={{ code: summary.error.code, message: summary.error.message }}
            resource="billing"
          />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">{summary.error.code}</CardTitle>
              <CardDescription>{summary.error.message}</CardDescription>
            </CardHeader>
          </Card>
        )
      ) : summary.data ? (
        (() => {
          const plan = summary.data.plan;
          const sub = summary.data.activeSubscription;
          const paidActive =
            !!sub && (sub.status === "active" || sub.status === "trialing") && (plan?.priceAmountCents ?? 0) > 0;
          const nextCharge =
            paidActive && plan && sub?.currentPeriodEnd
              ? `${formatMoney(plan.priceAmountCents, plan.priceCurrency)} on ${formatDate(sub.currentPeriodEnd)}`
              : null;
          return (
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="text-base">{plan ? plan.name : "No active plan"}</CardTitle>
                    <CardDescription>{plan ? planPriceLabel(plan) : "No active subscription"}</CardDescription>
                  </div>
                  {sub ? <Badge variant={statusVariant(sub.status)}>{sub.status}</Badge> : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <Stat label="Started" value={formatDate(sub?.currentPeriodStart ?? null)} />
                  <Stat label="Renews on" value={formatDate(sub?.currentPeriodEnd ?? null)} />
                  <Stat label="Next charge" value={nextCharge ?? "—"} />
                  <Stat
                    label="Billing contact"
                    value={summary.data.customer?.displayName ?? summary.data.customer?.email ?? "—"}
                  />
                </div>
                {nextCharge ? (
                  <p className="text-xs text-muted-foreground">
                    Estimated — applicable taxes are calculated at billing.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          );
        })()
      ) : null}

      {/* Manage plan: upgrade checkout + customer portal */}
      {summary.loading ? (
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ) : summary.data ? (
        <BillingActions
          orgId={orgId}
          activePlanCode={summary.data.plan?.code ?? null}
          providerManaged={!!summary.data.activeSubscription?.providerSubscriptionId}
        />
      ) : null}

      {/* Entitlements */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Entitlements
        </h2>
        {ents.loading ? (
          <Skeleton className="h-32 w-full" />
        ) : ents.error ? (
          ents.error.code === "precondition_failed" ? (
            <PreconditionInsight
              error={{ code: ents.error.code, message: ents.error.message }}
              resource="entitlement"
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-destructive text-sm">{ents.error.code}</CardTitle>
                <CardDescription>{ents.error.message}</CardDescription>
              </CardHeader>
            </Card>
          )
        ) : !ents.data || ents.data.entitlements.length === 0 ? (
          <EmptyState icon={Receipt} title="No entitlements" description="No entitlement records configured." />
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead>Limit</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ents.data.entitlements.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="font-mono text-xs">{e.entitlementKey}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{e.valueType}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={e.enabled ? "success" : "destructive"}>
                        {e.enabled ? "yes" : "no"}
                      </Badge>
                    </TableCell>
                    <TableCell>{e.limitValue === null ? "unlimited" : e.limitValue}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{e.source}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>

      {/* Invoices */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Invoices</h2>
        {inv.loading ? (
          <Skeleton className="h-24 w-full" />
        ) : inv.error ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive text-sm">{inv.error.code}</CardTitle>
              <CardDescription>{inv.error.message}</CardDescription>
            </CardHeader>
          </Card>
        ) : !inv.data || inv.data.invoices.length === 0 ? (
          <EmptyState icon={Receipt} title="No invoices" description="Invoices will appear here after first billing cycle." />
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Number</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Paid</TableHead>
                  <TableHead>Issued</TableHead>
                  <TableHead className="text-right">Receipt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inv.data.invoices.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">{i.number ?? i.id.slice(0, 12)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          i.status === "paid" ? "success" : i.status === "void" ? "secondary" : "warning"
                        }
                      >
                        {i.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{formatMoney(i.amountDueCents, i.currency)}</TableCell>
                    <TableCell>{formatMoney(i.amountPaidCents, i.currency)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(i.issuedAt)}</TableCell>
                    <TableCell className="text-right">
                      {i.hostedUrl ? (
                        <a
                          href={i.hostedUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          View <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-medium truncate">{value}</div>
    </div>
  );
}

/** Locale date, or an em dash when absent. */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Money from minor units, e.g. (2000, "usd") → "$20.00". */
function formatMoney(cents: number | null, currency: string): string {
  if (cents == null) return "—";
  const symbol = currency.toLowerCase() === "usd" ? "$" : `${currency.toUpperCase()} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

/** Plan price with interval, e.g. "$20.00 / month". Free/contact tiers read plainly. */
function planPriceLabel(plan: { priceAmountCents: number | null; priceCurrency: string; billingInterval: string }): string {
  if (plan.billingInterval === "none") return "Custom — contact sales";
  if (!plan.priceAmountCents) return "Free";
  const per = plan.billingInterval === "year" ? "year" : "month";
  return `${formatMoney(plan.priceAmountCents, plan.priceCurrency)} / ${per}`;
}

/** Badge variant for a subscription status. */
function statusVariant(status: string): "success" | "warning" | "secondary" | "destructive" {
  if (status === "active" || status === "trialing") return "success";
  if (status === "past_due") return "warning";
  if (status === "canceled" || status === "expired") return "destructive";
  return "secondary";
}
