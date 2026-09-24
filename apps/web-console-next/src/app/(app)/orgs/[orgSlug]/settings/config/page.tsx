"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Settings } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfigSurface } from "@/components/config/config-surface";

export default function ConfigPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => (
        <div className="space-y-5">
          <header>
            <div className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-muted-foreground" />
              <h1 className="text-xl font-semibold tracking-tight">Configuration</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Organization-scoped settings, feature flags, and secrets. Project and environment
              scopes live on their own pages.
            </p>
          </header>

          <ConfigSurface scope={{ kind: "organization", orgId: org.id }} />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Organization identifiers</CardTitle>
              <CardDescription>Stable references for use in API and SDK calls.</CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-[11px] uppercase text-muted-foreground">Name</dt>
                  <dd className="font-medium">{org.name}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase text-muted-foreground">Slug</dt>
                  <dd>
                    <Badge variant="secondary">{org.slug}</Badge>
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-[11px] uppercase text-muted-foreground">Org ID</dt>
                  <dd className="font-mono text-xs break-all">{org.id}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      )}
    </OrgScope>
  );
}
