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
  validateName,
  validateDescription,
  generateIdempotencyKey,
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
 * Create-endpoint dialog.
 *
 * Mirrors the invitations create-flow shape:
 *   - ZodForm with co-located schema
 *   - wrap() error handling
 *   - precondition_failed → <PreconditionInsight />
 *   - other errors → useToast
 *   - Idempotency-Key generated per submission via SDK opts
 *
 * On success, calls `onCreated(endpointId)` so the parent can route to
 * the detail page and trigger a list refresh.
 */
export function CreateEndpointDialog({
  orgId,
  open,
  onOpenChange,
  onCreated,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (endpointId: string) => void;
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
            <DialogTitle>New webhook endpoint</DialogTitle>
            <DialogDescription>
              Endpoints receive signed event deliveries from this organization.
              The signing secret is shown exactly once after creation, on the
              endpoint detail page.
            </DialogDescription>
          </DialogHeader>
          <ZodForm
            schema={schema}
            defaultValues={{ url: "", name: "", description: "" }}
            fields={[
              {
                name: "url",
                label: "URL",
                type: "text",
                placeholder: "https://example.com/hook",
                hint: "Must be reachable from the public internet over http(s).",
              },
              {
                name: "name",
                label: "Name",
                type: "text",
                placeholder: "Production receiver",
                hint: "Optional. Shown in the console list.",
              },
              {
                name: "description",
                label: "Description",
                type: "text",
                placeholder: "Receives all webhook events for the prod tenant",
                hint: "Optional. Free-form notes for your team.",
              },
            ]}
            submitLabel="Create endpoint"
            cancel={{ label: "Cancel", onClick: () => onOpenChange(false) }}
            onSubmit={async (v) => {
              const body: { url: string; name?: string; description?: string } = {
                url: v.url.trim(),
              };
              if (v.name && v.name.trim()) body.name = v.name.trim();
              if (v.description && v.description.trim())
                body.description = v.description.trim();

              // Validate beyond zod (URL parse) — keeps message user-readable
              const urlCheck = validateEndpointUrl(body.url);
              if (!urlCheck.ok) {
                toast({
                  kind: "error",
                  title: "Invalid URL",
                  description: urlCheck.message ?? "Enter a valid URL",
                });
                return;
              }
              const nameCheck = validateName(v.name ?? "");
              if (!nameCheck.ok) {
                toast({ kind: "error", title: "Invalid name", description: nameCheck.message });
                return;
              }
              const descCheck = validateDescription(v.description ?? "");
              if (!descCheck.ok) {
                toast({
                  kind: "error",
                  title: "Invalid description",
                  description: descCheck.message,
                });
                return;
              }

              const idempotencyKey = generateIdempotencyKey();
              const r = await wrap(() =>
                client.webhooks.createEndpoint(orgId, body, { idempotencyKey }),
              );
              if (!r.ok) {
                if (r.error.code === "precondition_failed") setPrecondition(r.error);
                else
                  toast({
                    kind: "error",
                    title: "Create failed",
                    description: r.error.message,
                  });
                return;
              }
              toast({
                kind: "success",
                title: "Endpoint created",
                description: r.data.endpoint.url,
              });
              onOpenChange(false);
              onCreated(r.data.endpoint.id);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
