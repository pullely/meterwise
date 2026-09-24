"use client";

import * as React from "react";
import { z } from "zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ZodForm } from "@/components/ui/zod-form";
import { useToast } from "@/components/ui/toast";
import { PreconditionInsight } from "@/components/precondition/insight";
import { useSession } from "@/lib/session";
import { wrap, type ApiErrorBody } from "@/lib/api";
import {
  validateEndpointUrl,
  buildUpdatePatch,
  type EndpointSnapshot,
  NAME_MAX,
  DESCRIPTION_MAX,
} from "./endpoint-crud";

const schema = z.object({
  url: z
    .string()
    .min(1, "URL is required")
    .refine((v) => validateEndpointUrl(v).ok, {
      message: "Enter a valid http(s) URL",
    }),
  name: z
    .string()
    .max(NAME_MAX, `Keep the name under ${NAME_MAX} characters`)
    .optional()
    .or(z.literal("")),
  description: z
    .string()
    .max(DESCRIPTION_MAX, `Keep the description under ${DESCRIPTION_MAX} characters`)
    .optional()
    .or(z.literal("")),
});

/**
 * Edit-endpoint dialog.
 *
 * PATCH only the fields the operator actually changed. If the diff is
 * empty, we short-circuit with a toast — no network call.
 */
export function EditEndpointDialog({
  orgId,
  endpointId,
  current,
  open,
  onOpenChange,
  onUpdated,
}: {
  orgId: string;
  endpointId: string;
  current: EndpointSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [precondition, setPrecondition] = React.useState<ApiErrorBody | null>(null);

  return (
    <>
      {precondition && (
        <PreconditionInsight
          error={precondition}
          resource="webhook endpoint"
          onDismiss={() => setPrecondition(null)}
        />
      )}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit webhook endpoint</DialogTitle>
            <DialogDescription>
              Update the destination URL or operator-facing labels. The
              signing-secret rotation flow is unchanged.
            </DialogDescription>
          </DialogHeader>
          <ZodForm
            schema={schema}
            defaultValues={{
              url: current.url,
              name: current.name ?? "",
              description: current.description ?? "",
            }}
            fields={[
              { name: "url", label: "URL", type: "text" },
              {
                name: "name",
                label: "Name",
                type: "text",
                hint: "Optional. Leave empty to clear.",
              },
              {
                name: "description",
                label: "Description",
                type: "text",
                hint: "Optional. Leave empty to clear.",
              },
            ]}
            submitLabel="Save changes"
            cancel={{ label: "Cancel", onClick: () => onOpenChange(false) }}
            onSubmit={async (v) => {
              const patch = buildUpdatePatch(current, {
                url: v.url,
                name: v.name ?? "",
                description: v.description ?? "",
              });
              if (!patch) {
                toast({
                  kind: "default",
                  title: "Nothing to update",
                  description: "No changes detected.",
                });
                onOpenChange(false);
                return;
              }
              const r = await wrap(() =>
                client.webhooks.updateEndpoint(orgId, endpointId, patch),
              );
              if (!r.ok) {
                if (r.error.code === "precondition_failed") setPrecondition(r.error);
                else
                  toast({
                    kind: "error",
                    title: "Update failed",
                    description: r.error.message,
                  });
                return;
              }
              toast({ kind: "success", title: "Endpoint updated" });
              onOpenChange(false);
              onUpdated();
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
