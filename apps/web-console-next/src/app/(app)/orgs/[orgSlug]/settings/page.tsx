"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import { SettingsCard } from "@/components/settings/settings-card";
import { PRODUCT_NAME } from "@/lib/app-config";
import { TENANT_NOUN } from "@/lib/solo-mode";

export default function OrgSettingsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner org={org} />}</OrgScope>;
}

function Inner({ org }: { org: { id: string; name: string; slug: string } }) {
  // Solo relabels the tenant noun: in M0 the org reads as the user's "Account".
  const noun = TENANT_NOUN; // "Organization" (baseline) | "Account" (solo)
  const nounLower = noun.toLowerCase();
  return (
    <div className="space-y-6">
      <SettingsCard
        title={`${noun} Name`}
        description={`This is your ${nounLower}'s visible name within ${PRODUCT_NAME}.`}
        footerHint={`Renaming an ${nounLower} isn't available from the console yet.`}
      >
        <Input value={org.name} disabled className="max-w-md" aria-label={`${noun} name`} />
      </SettingsCard>

      <SettingsCard
        title={`${noun} Slug`}
        description={`This is your ${nounLower}'s URL namespace on ${PRODUCT_NAME}. It identifies your ${nounLower} across the console and the API.`}
        footerHint="Used in console URLs and API requests."
        footerAction={<CopyButton value={org.slug} />}
      >
        <div className="flex max-w-md items-stretch overflow-hidden rounded-md border bg-muted/40">
          <span className="select-none border-r px-3 py-2 text-sm text-muted-foreground">
            /orgs/
          </span>
          <input
            value={org.slug}
            disabled
            aria-label={`${noun} slug`}
            className="w-full bg-transparent px-3 py-2 text-sm text-foreground outline-none"
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title={`${noun} ID`}
        description={`Use this identifier when contacting support or making API requests on behalf of this ${nounLower}.`}
        footerHint={`A unique, stable identifier for this ${nounLower}.`}
        footerAction={<CopyButton value={org.id} />}
      >
        <Input value={org.id} disabled className="max-w-md font-mono text-xs" aria-label={`${noun} ID`} />
      </SettingsCard>

      <SettingsCard
        tone="danger"
        title={`Delete ${noun}`}
        description={`Permanently remove this ${nounLower} along with its data. This action cannot be undone.`}
        footerHint={`${noun} deletion is handled by support to protect against accidental, irreversible data loss.`}
        footerAction={
          <Button variant="outline" size="sm" disabled>
            Delete…
          </Button>
        }
      />
    </div>
  );
}
