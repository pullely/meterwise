"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { wrap } from "@/lib/api";

export default function PricesPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const [version, setVersion] = React.useState<string>("");
  const prices = useApiQuery(qk.llmPrices(orgId, version || "latest"), () =>
    wrap(async () => client.ledger.prices(orgId, version ? { version } : {})),
  );
  const p = prices.data;
  const current = p?.versions.find((v) => v.version === p.version);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Price table</h1>
        <p className="text-sm text-muted-foreground">
          The list prices every call is costed at, per million tokens, read from each provider&apos;s own pricing page.
          A price change is a new version: a stored cost keeps the version that priced it.
        </p>
      </header>

      {prices.loading ? (
        <Skeleton className="h-40 w-full" />
      ) : prices.error ? (
        <p className="text-sm text-destructive">{prices.error.message}</p>
      ) : p ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Version {p.version}</CardTitle>
            <CardDescription>
              {current ? `In effect from ${current.effectiveFrom}. ${current.description}` : null}
            </CardDescription>
            {p.versions.length > 1 && (
              <div className="flex flex-wrap gap-1 pt-2">
                {p.versions.map((v) => (
                  <Button key={v.version} size="sm" variant={v.version === p.version ? "default" : "outline"} onClick={() => setVersion(v.version)}>
                    {v.version}
                  </Button>
                ))}
              </div>
            )}
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Provider</TH>
                  <TH>Model</TH>
                  <TH className="text-right">Input / MTok</TH>
                  <TH className="text-right">Output / MTok</TH>
                  <TH>Source</TH>
                </TR>
              </THead>
              <TBody>
                {p.prices.map((r) => (
                  <TR key={`${r.provider}/${r.model}`}>
                    <TD>{r.provider}</TD>
                    <TD>
                      <div className="font-medium">{r.displayName}</div>
                      <div className="font-mono text-xs text-muted-foreground">{r.model}</div>
                    </TD>
                    <TD className="text-right font-mono">{r.inputPerMtok}</TD>
                    <TD className="text-right font-mono">{r.outputPerMtok}</TD>
                    <TD className="text-xs">
                      <a className="underline" href={r.sourceUrl} target="_blank" rel="noreferrer">
                        read {r.checkedOn}
                      </a>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
