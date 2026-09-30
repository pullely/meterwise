"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import type { PublicAlert, PublicBudget } from "@saas/contracts/ledger";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";
import { dollarsToNano } from "@/lib/money";

function usd(costUsd: string | null): string {
  if (costUsd === null) return "—";
  const [whole, frac = ""] = costUsd.split(".");
  const trimmed = frac.replace(/0+$/, "");
  return `$${whole}.${trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed.slice(0, 6)}`;
}

const KIND_LABEL: Record<PublicAlert["kind"], string> = {
  runaway_loop: "Runaway loop",
  abusive_user: "Abusive end-user",
  budget_soft: "Soft budget reached",
  budget_hard: "Hard budget reached",
};

export default function BudgetsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const budgets = useApiQuery(qk.llmBudgets(orgId), () => wrap(async () => client.ledger.budgets(orgId)));
  const alerts = useApiQuery(qk.llmAlerts(orgId), () => wrap(async () => client.ledger.alerts(orgId)));
  const [tenant, setTenant] = React.useState("");
  const [soft, setSoft] = React.useState("");
  const [hard, setHard] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const s = dollarsToNano(soft);
    const h = dollarsToNano(hard);
    if (Number.isNaN(s) || Number.isNaN(h)) return setError("Limits are dollar amounts, such as 25 or 0.50.");
    if (s === null && h === null) return setError("Set a soft limit, a hard limit, or both.");
    const downgrade = from.trim() && to.trim() ? { [from.trim().toLowerCase()]: to.trim().toLowerCase() } : {};
    setBusy(true);
    const r = await wrap(async () =>
      client.ledger.putBudget(orgId, tenant.trim() || "*", { softLimitNanoUsd: s, hardLimitNanoUsd: h, downgrade }),
    );
    setBusy(false);
    if (!r.ok) return setError(r.error.message);
    setTenant("");
    setSoft("");
    setHard("");
    setFrom("");
    setTo("");
    budgets.reload();
  }

  async function remove(b: PublicBudget) {
    const r = await wrap(async () => client.ledger.deleteBudget(orgId, b.tenant));
    if (!r.ok) return setError(r.error.message);
    budgets.reload();
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Budgets &amp; alerts</h1>
        <p className="text-sm text-muted-foreground">
          A monthly (UTC) LLM budget per tenant. Past the soft limit the pre-flight check answers <em>warn</em>, or
          <em> downgrade</em> to the cheaper model you map; past the hard limit it answers <em>deny</em>. The check is
          advisory: calls already in flight when a hard limit is crossed can overshoot it by their own cost.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Set a budget</CardTitle>
          <CardDescription>Leave the tenant empty for the default that applies to every tenant without its own.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-wrap items-end gap-2 text-sm" onSubmit={save}>
            <Input className="w-40" placeholder="tenant (or empty)" value={tenant} onChange={(e) => setTenant(e.target.value)} aria-label="Tenant" />
            <Input className="w-28" placeholder="soft $" value={soft} onChange={(e) => setSoft(e.target.value)} aria-label="Soft limit" />
            <Input className="w-28" placeholder="hard $" value={hard} onChange={(e) => setHard(e.target.value)} aria-label="Hard limit" />
            <Input className="w-36" placeholder="downgrade from" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Downgrade from model" />
            <Input className="w-36" placeholder="to model" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Downgrade to model" />
            <Button type="submit" size="sm" disabled={busy}>
              Save
            </Button>
          </form>
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          {budgets.loading ? (
            <Skeleton className="h-24 w-full" />
          ) : budgets.error ? (
            <p className="text-sm text-destructive">{budgets.error.message}</p>
          ) : budgets.data && budgets.data.budgets.length > 0 ? (
            <Table>
              <THead>
                <TR>
                  <TH>Tenant</TH>
                  <TH className="text-right">Spent ({budgets.data.period})</TH>
                  <TH className="text-right">Soft</TH>
                  <TH className="text-right">Hard</TH>
                  <TH>Downgrade</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {budgets.data.budgets.map((b) => (
                  <TR key={b.id}>
                    <TD>{b.tenant === "*" ? "Default (every other tenant)" : b.tenant}</TD>
                    <TD className="text-right font-mono">{b.tenant === "*" ? "per tenant" : usd(b.spentUsd)}</TD>
                    <TD className="text-right font-mono">{usd(b.softLimitUsd)}</TD>
                    <TD className="text-right font-mono">{usd(b.hardLimitUsd)}</TD>
                    <TD className="font-mono text-xs">
                      {Object.entries(b.downgrade).map(([f, t]) => `${f} → ${t}`).join(", ") || "—"}
                    </TD>
                    <TD className="text-right">
                      <Button size="sm" variant="outline" onClick={() => void remove(b)}>
                        Remove
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No budgets yet: every check answers allow.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Alerts</CardTitle>
          <CardDescription>
            Checked every 15 minutes: a runaway loop (over 10× a tenant&apos;s usual hourly calls and over 200), one end-user
            over half a tenant&apos;s spend and over $5 in an hour, and budgets reached. Owners and admins get one email per alert.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {alerts.loading ? (
            <Skeleton className="h-16 w-full" />
          ) : alerts.data && alerts.data.alerts.length > 0 ? (
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Alert</TH>
                  <TH>Tenant</TH>
                  <TH>Detail</TH>
                  <TH className="text-right">Emails accepted</TH>
                </TR>
              </THead>
              <TBody>
                {alerts.data.alerts.map((a) => (
                  <TR key={a.id}>
                    <TD className="text-xs">{a.createdAt.replace("T", " ").slice(0, 16)}</TD>
                    <TD>{KIND_LABEL[a.kind]}</TD>
                    <TD>{a.tenant}</TD>
                    <TD className="text-xs">{a.feature ?? a.user ?? (typeof a.detail.period === "string" ? a.detail.period : "")}</TD>
                    <TD className="text-right">
                      {a.accepted} / {a.recipients}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No alerts.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
