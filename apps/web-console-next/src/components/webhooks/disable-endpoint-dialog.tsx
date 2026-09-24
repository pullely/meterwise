"use client";

import * as React from "react";
import { ShieldOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { PreconditionInsight } from "@/components/precondition/insight";
import { useSession } from "@/lib/session";
import { wrap, type ApiErrorBody } from "@/lib/api";
import {
  validateDisabledReason,
  DISABLED_REASON_MAX,
} from "./endpoint-crud";

/**
 * Disable-endpoint dialog.
 *
 * Optional reason field surfaced as a single-line input (the worker
 * accepts a string; multi-line is unnecessary). The disable call is
 * idempotent on the worker side — repeated calls land the same status
 * — but we still gate the button to prevent UI double-submits.
 */
export function DisableEndpointDialog({
  orgId,
  endpointId,
  endpointLabel,
  open,
  onOpenChange,
  onDisabled,
}: {
  orgId: string;
  endpointId: string;
  endpointLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisabled: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [precondition, setPrecondition] = React.useState<ApiErrorBody | null>(null);

  // Reset local form state whenever the dialog reopens.
  React.useEffect(() => {
    if (open) {
      setReason("");
      setBusy(false);
    }
  }, [open]);

  const reasonCheck = validateDisabledReason(reason);

  const handleConfirm = React.useCallback(async () => {
    if (!reasonCheck.ok) {
      toast({
        kind: "error",
        title: "Invalid reason",
        description: reasonCheck.message,
      });
      return;
    }
    setBusy(true);
    const body = reason.trim() ? { reason: reason.trim() } : {};
    const r = await wrap(() =>
      client.webhooks.disableEndpoint(orgId, endpointId, body),
    );
    setBusy(false);
    if (!r.ok) {
      if (r.error.code === "precondition_failed") setPrecondition(r.error);
      else
        toast({
          kind: "error",
          title: "Disable failed",
          description: r.error.message,
        });
      return;
    }
    toast({ kind: "success", title: "Endpoint disabled" });
    onOpenChange(false);
    onDisabled();
  }, [client, orgId, endpointId, reason, reasonCheck, toast, onOpenChange, onDisabled]);

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
              <ShieldOff className="h-4 w-4 text-destructive" />
              Disable webhook endpoint
            </DialogTitle>
            <DialogDescription>
              Disabling <span className="font-mono">{endpointLabel}</span> stops
              all delivery attempts to this URL. The endpoint stays in the list
              and can still be inspected, but no events will be sent.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="disable-reason">Reason (optional)</Label>
            <Input
              id="disable-reason"
              placeholder="Receiver maintenance window"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={DISABLED_REASON_MAX + 1}
              aria-invalid={!reasonCheck.ok || undefined}
            />
            {!reasonCheck.ok ? (
              <p className="text-xs text-destructive">{reasonCheck.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Surfaced on the detail page so your team knows why it&rsquo;s off.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirm}
              loading={busy}
              disabled={!reasonCheck.ok}
            >
              Disable endpoint
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
