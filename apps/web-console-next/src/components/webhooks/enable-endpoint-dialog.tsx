"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { PreconditionInsight } from "@/components/precondition/insight";
import { useSession } from "@/lib/session";
import { wrap, type ApiErrorBody } from "@/lib/api";

/**
 * Re-enable-endpoint dialog.
 *
 * Empty body — the contract surface carries no fields. The worker
 * idempotently returns 404 if the endpoint is already active or missing,
 * which we surface as a `PreconditionInsight` for clarity instead of a
 * raw error toast.
 */
export function EnableEndpointDialog({
  orgId,
  endpointId,
  endpointLabel,
  open,
  onOpenChange,
  onEnabled,
}: {
  orgId: string;
  endpointId: string;
  endpointLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEnabled: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [precondition, setPrecondition] = React.useState<ApiErrorBody | null>(null);

  React.useEffect(() => {
    if (open) setBusy(false);
  }, [open]);

  const handleConfirm = React.useCallback(async () => {
    setBusy(true);
    const r = await wrap(() =>
      client.webhooks.enableEndpoint(orgId, endpointId),
    );
    setBusy(false);
    if (!r.ok) {
      if (r.error.code === "precondition_failed") setPrecondition(r.error);
      else
        toast({
          kind: "error",
          title: "Re-enable failed",
          description: r.error.message,
        });
      return;
    }
    toast({ kind: "success", title: "Endpoint re-enabled" });
    onOpenChange(false);
    onEnabled();
  }, [client, orgId, endpointId, toast, onOpenChange, onEnabled]);

  return (
    <>
      {precondition && (
        <PreconditionInsight
          error={precondition}
          resource="webhook endpoint"
          onDismiss={() => setPrecondition(null)}
        />
      )}
      <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              Re-enable webhook endpoint
            </DialogTitle>
            <DialogDescription>
              Re-enabling{" "}
              <span className="font-mono">{endpointLabel}</span> resumes
              delivery on the next matching event. The signing secret is
              unchanged. Any reason recorded when the endpoint was disabled
              is cleared from the metadata.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={handleConfirm} loading={busy}>
              Re-enable endpoint
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
