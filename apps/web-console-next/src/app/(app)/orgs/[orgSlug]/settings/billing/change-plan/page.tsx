"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { ChangePlanCards } from "@/components/billing/change-plan-cards";

export default function ChangePlanPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => (
        <div className="space-y-6">
          <header className="space-y-1">
            <Link
              href={`/orgs/${slug}/settings/billing`}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" /> Back to Billing
            </Link>
            <h1 className="text-xl font-semibold tracking-tight">Change plan</h1>
            <p className="text-sm text-muted-foreground">
              Pick a new plan for this organization. You can change again at any time.
            </p>
          </header>
          <ChangePlanCards orgId={org.id} orgSlug={slug} />
        </div>
      )}
    </OrgScope>
  );
}
