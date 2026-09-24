"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CircleDollarSign } from "lucide-react";
import type { CostDimension, CostRow } from "@saas/contracts/ledger";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";

const DIMENSIONS: { by: CostDimension; label: string }[] = [
  { by: "tenant", label: "Tenant" },
  { by: "feature", label: "Feature" },
  { by: "model", label: "Model" },
  { by: "user", label: "End-user" },
  { by: "provider", label: "Provider" },
];

/** "$0.0295" — enough places that a single cheap call is not "$0.00". */
function usd(costUsd: string): string {
  const [whole, frac = ""] = costUsd.split(".");
  const trimmed = frac.replace(/0+$/, "");
  return `$${whole}.${trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed.slice(0, 6)}`;
}

function keyLabel(by: CostDimension, row: CostRow): string {
  if (by === "model") return `${row.key.provider ?? "?"} / ${row.key.model ?? "?"}`;
  return row.key[by] ?? "(not reported)";
}

export default function CostsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} slug={slug} />}</OrgScope>;
}

function Inner({ orgId, slug }: { orgId: string; slug: string }) {
  const { client } = useSession();
  const today = new Date().toISOString().slice(0, 10);
  const [by, setBy] = React.useState<CostDimension>("tenant");
  const [from, setFrom] = React.useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = React.useState(today);
  const costs = useApiQuery(qk.llmCosts(orgId, by, from, to), () => wrap(async () => client.ledger.costs(orgId, { by, from, to })));
  const events = useApiQuery(qk.llmEvents(orgId), () => wrap(async () => client.ledger.events(orgId, { limit: 20 })));
  const c = costs.data;

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Costs</h1>
        <p className="text-sm text-muted-foreground">
          What your LLM calls cost, per tenant, feature, model and end-user, priced at list price with the base input and
          output rates of the <Link className="underline" href={`/orgs/${slug}/prices`}>price table</Link>.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Report usage</CardTitle>
          <CardDescription>
            Create an <Link className="underline" href={`/orgs/${slug}/api-keys`}>API key</Link> with the builder role,
            keep it server-side, and send each call after it returns. Retries are safe: an event is counted once per eventId.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{`POST /v1/organizations/${orgId}/llm-events
Authorization: Bearer <api key>
{ "events": [{ "eventId": "<uuid made before the call>", "tenant": "acme", "feature": "summarize",
               "user": "u-42", "provider": "openai", "model": "gpt-4o",
               "inputTokens": 1000, "outputTokens": 500, "latencyMs": 820 }] }`}</pre>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex gap-1">
          {DIMENSIONS.map((d) => (
            <Button key={d.by} size="sm" variant={d.by === by ? "default" : "outline"} onClick={() => setBy(d.by)}>
              {d.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Input className="w-40" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          <span>to</span>
          <Input className="w-40" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          {costs.loading ? (
            <Skeleton className="h-24 w-full" />
          ) : costs.error ? (
            <p className="text-sm text-destructive">{costs.error.message}</p>
          ) : !c || c.rows.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-center text-sm text-muted-foreground">
              <CircleDollarSign className="mb-3 h-8 w-8 text-primary" />
              No usage reported in this window.
            </div>
          ) : (
            <>
              <p className="mb-3 text-sm">
                <span className="text-2xl font-semibold">{usd(c.totals.costUsd)}</span>{" "}
                <span className="text-muted-foreground">
                  over {c.totals.events.toLocaleString()} calls, {c.from} to {c.to}
                  {c.priceVersions.length > 0 && <> · price table {c.priceVersions.join(", ")}</>}
                </span>
              </p>
              {c.totals.unpricedEvents > 0 && (
                <p className="mb-3 text-xs text-muted-foreground">
                  {c.totals.unpricedEvents.toLocaleString()} calls used a model the price table does not know yet. They are
                  counted here but not priced.
                </p>
              )}
              <Table>
                <THead>
                  <TR>
                    <TH>{DIMENSIONS.find((d) => d.by === by)?.label}</TH>
                    <TH className="text-right">Calls</TH>
                    <TH className="text-right">Input tokens</TH>
                    <TH className="text-right">Output tokens</TH>
                    <TH className="text-right">Avg latency</TH>
                    <TH className="text-right">Cost</TH>
                  </TR>
                </THead>
                <TBody>
                  {c.rows.map((r, i) => (
                    <TR key={i}>
                      <TD className="font-medium">{keyLabel(by, r)}</TD>
                      <TD className="text-right">
                        {r.events.toLocaleString()}
                        {r.unpricedEvents > 0 && <span className="text-xs text-muted-foreground"> ({r.unpricedEvents} unpriced)</span>}
                      </TD>
                      <TD className="text-right">{r.inputTokens.toLocaleString()}</TD>
                      <TD className="text-right">{r.outputTokens.toLocaleString()}</TD>
                      <TD className="text-right">{r.avgLatencyMs === null ? "—" : `${r.avgLatencyMs} ms`}</TD>
                      <TD className="text-right font-mono">{usd(r.costUsd)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent calls</CardTitle>
        </CardHeader>
        <CardContent>
          {events.loading ? (
            <Skeleton className="h-16 w-full" />
          ) : (events.data?.events ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing reported yet.</p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Tenant</TH>
                  <TH>Feature</TH>
                  <TH>Model</TH>
                  <TH className="text-right">Tokens in / out</TH>
                  <TH className="text-right">Cost</TH>
                </TR>
              </THead>
              <TBody>
                {(events.data?.events ?? []).map((e) => (
                  <TR key={e.id}>
                    <TD className="text-xs">{new Date(e.occurredAt).toLocaleString()}</TD>
                    <TD>{e.tenant}</TD>
                    <TD>{e.feature ?? "—"}</TD>
                    <TD className="text-xs">{e.provider} / {e.model}</TD>
                    <TD className="text-right text-xs">{e.inputTokens.toLocaleString()} / {e.outputTokens.toLocaleString()}</TD>
                    <TD className="text-right font-mono text-xs">{e.costUsd === null ? e.priceStatus.replace(/_/g, " ") : usd(e.costUsd)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
