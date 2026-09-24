"use client";

import * as React from "react";
import { Trash2, AlertTriangle } from "lucide-react";
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
import { confirmDeleteMatches } from "./endpoint-crud";

/**
 * Destructive delete dialog with typed-confirmation gate.
 *
 * The operator must type the endpoint URL exactly. Pattern mirrors the
 * rotate-secret dialog's destructive-confirm density. On success, calls
 * `onDeleted()` so the parent can route back to the list.
 */
export function DeleteEndpointDialog({
  orgId,
  endpointId,
  endpointUrl,
  open,
  onOpenChange,
  onDeleted,
}: {
  orgId: string;
  endpointId: string;
  endpointUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [precondition, setPrecondition] = React.useState<ApiErrorBody | null>(null);

  React.useEffect(() => {
    if (open) {
      setTyped("");
      setBusy(false);
    }
  }, [open]);

  const matches = confirmDeleteMatches(typed, endpointUrl);

  const handleConfirm = React.useCallback(async () => {
    if (!matches) return;
    setBusy(true);
    const r = await wrap(() => client.webhooks.deleteEndpoint(orgId, endpointId));
    setBusy(false);
    if (!r.ok) {
      if (r.error.code === "precondition_failed") setPrecondition(r.error);
      else
        toast({
          kind: "error",
          title: "Delete failed",
          description: r.error.message,
        });
      return;
    }
    toast({ kind: "success", title: "Endpoint deleted" });
    onOpenChange(false);
    onDeleted();
  }, [client, orgId, endpointId, matches, toast, onOpenChange, onDeleted]);

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
              <Trash2 className="h-4 w-4 text-destructive" />
              Delete webhook endpoint
            </DialogTitle>
            <DialogDescription>
              This permanently removes the endpoint and severs any subscriptions
              attached to it. Pending deliveries will not be retried.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-amber-500 shrink-0" />
              <p>
                To confirm, type the endpoint URL exactly. This protects against
                accidental deletion of the wrong endpoint.
              </p>
            </div>
            <p className="font-mono break-all text-foreground">{endpointUrl}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-url">Type the URL to confirm</Label>
            <Input
              id="confirm-url"
              placeholder={endpointUrl}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typed.length > 0 && !matches ? true : undefined}
            />
            {typed.length > 0 && !matches && (
              <p className="text-xs text-destructive">
                URL doesn&rsquo;t match — case and characters must be exact.
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
              disabled={!matches}
            >
              Delete endpoint
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
