"use client";

import * as React from "react";
import { Copy, Check, ShieldAlert, AlertTriangle } from "lucide-react";
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
import { wrap, type ApiErrorBody } from "@/lib/api";
import { useSession } from "@/lib/session";
import { PreconditionInsight } from "@/components/precondition/insight";
import {
  nextRotateState,
  formatGraceWindow,
  formatGraceDuration,
  type RotateState,
} from "./rotate-flow";

/**
 * Reveal-once webhook signing-secret rotation dialog.
 *
 * Flow:
 *   1. Caller flips `open=true` → confirm dialog opens.
 *   2. Operator clicks "Rotate signing secret" → SDK call via `wrap()`.
 *   3. On success, the confirm dialog hands off to a reveal-once dialog
 *      that displays the plaintext `whsec_…` secret in a monospace block
 *      with copy-to-clipboard + grace-window context.
 *   4. Closing the reveal dialog dispatches `closeReveal`, which the state
 *      machine resolves to `{ phase: "idle" }` — dropping the secret. The
 *      secret only ever lives in this component's local state. No query
 *      cache, no `sessionStorage`, no `localStorage`.
 *
 * The dual-dialog shape (confirm ↔ reveal) is intentional: it mirrors the
 * api-keys precedent and gives the operator an unambiguous "destructive,
 * one-shot" moment.
 */
export function RotateSecretDialog({
  orgId,
  endpointId,
  endpointLabel,
  open,
  onOpenChange,
  onRotated,
}: {
  orgId: string;
  endpointId: string;
  endpointLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRotated?: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [state, setState] = React.useState<RotateState>({ phase: "idle" });
  const [copied, setCopied] = React.useState(false);
  const [precondition, setPrecondition] = React.useState<ApiErrorBody | null>(null);

  // Sync external `open` to the state machine so callers can toggle the
  // dialog from a parent button. Reading current phase via a ref keeps the
  // effect's dep list to `[open]` only — the parent is the sole driver of
  // "should this flow be active". The reveal phase is owned internally —
  // closing it routes back to onOpenChange(false) in the reveal dialog.
  const stateRef = React.useRef(state);
  stateRef.current = state;
  React.useEffect(() => {
    const phase = stateRef.current.phase;
    if (open && phase === "idle") {
      setState(nextRotateState(stateRef.current, { type: "openConfirm" }));
    } else if (!open && phase === "confirming") {
      setState(nextRotateState(stateRef.current, { type: "cancelConfirm" }));
    }
  }, [open]);

  // Defensive scrub: if the component unmounts mid-reveal, drop the secret.
  React.useEffect(() => {
    return () => {
      setState({ phase: "idle" });
    };
  }, []);

  const closeAll = React.useCallback(() => {
    setState({ phase: "idle" });
    setCopied(false);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleConfirm = React.useCallback(async () => {
    setState((s) => nextRotateState(s, { type: "confirmRotate" }));
    const r = await wrap(() => client.webhooks.rotateSecret(orgId, endpointId));
    if (!r.ok) {
      setState((s) => nextRotateState(s, { type: "rotateFailed" }));
      if (r.error.code === "precondition_failed") {
        setPrecondition(r.error);
      } else {
        toast({
          kind: "error",
          title: "Rotation failed",
          description: r.error.message,
        });
      }
      onOpenChange(false);
      return;
    }
    setState((s) =>
      nextRotateState(s, {
        type: "rotateSucceeded",
        secret: r.data.secret,
        previousSecretExpiresAt: r.data.previousSecretExpiresAt,
        gracePeriodSeconds: r.data.gracePeriodSeconds,
      }),
    );
    if (onRotated) onRotated();
  }, [client, orgId, endpointId, toast, onOpenChange, onRotated]);

  const inConfirm = state.phase === "confirming" || state.phase === "rotating";
  const inReveal = state.phase === "revealing";

  return (
    <>
      {precondition && (
        <PreconditionInsight
          error={precondition}
          resource="webhook endpoint"
          onDismiss={() => setPrecondition(null)}
        />
      )}

      {/* Confirm dialog — destructive styling, explicit Rotate action. */}
      <Dialog
        open={inConfirm}
        onOpenChange={(o) => {
          if (!o && state.phase === "confirming") closeAll();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-destructive" />
              Rotate signing secret
            </DialogTitle>
            <DialogDescription>
              You&rsquo;re about to rotate the signing secret for{" "}
              <span className="font-mono">{endpointLabel}</span>. The new
              secret will be shown <strong>exactly once</strong>. The previous
              secret will keep producing a valid{" "}
              <span className="font-mono">X-Webhook-Signature-Previous</span>{" "}
              header during the grace window — after that, deliveries signed
              with the old secret will be rejected by your receiver.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-amber-500 shrink-0" />
              <p>
                Receivers that don&rsquo;t implement dual-secret verification
                will start rejecting events the moment the previous secret
                expires. Plan your receiver rollout before confirming.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={closeAll}
              disabled={state.phase === "rotating"}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirm}
              loading={state.phase === "rotating"}
            >
              Rotate signing secret
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reveal-once dialog — the secret lives only in `state` and is
          dropped when this dialog closes. */}
      <Dialog
        open={inReveal}
        onOpenChange={(o) => {
          if (!o) closeAll();
        }}
      >
        <DialogContent>
          {inReveal && (
            <RevealOnceContent
              endpointLabel={endpointLabel}
              secret={state.secret}
              previousSecretExpiresAt={state.previousSecretExpiresAt}
              gracePeriodSeconds={state.gracePeriodSeconds}
              copied={copied}
              onCopy={async () => {
                if (!state.secret) return;
                try {
                  await navigator.clipboard.writeText(state.secret);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  toast({
                    kind: "error",
                    title: "Copy failed",
                    description: "Clipboard access was blocked. Select the secret manually.",
                  });
                }
              }}
              onDone={closeAll}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function RevealOnceContent({
  endpointLabel,
  secret,
  previousSecretExpiresAt,
  gracePeriodSeconds,
  copied,
  onCopy,
  onDone,
}: {
  endpointLabel: string;
  secret: string | null;
  previousSecretExpiresAt: string | null;
  gracePeriodSeconds: number;
  copied: boolean;
  onCopy: () => Promise<void> | void;
  onDone: () => void;
}) {
  const grace = formatGraceWindow(previousSecretExpiresAt, gracePeriodSeconds);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Signing secret rotated</DialogTitle>
        <DialogDescription>
          This is the only time you&rsquo;ll see the new secret for{" "}
          <span className="font-mono">{endpointLabel}</span>. Copy it now and
          store it in your receiver&rsquo;s secrets store.
        </DialogDescription>
      </DialogHeader>

      {secret ? (
        <div
          className="rounded-md bg-muted p-3 font-mono text-xs break-all border"
          data-testid="webhook-rotate-secret"
        >
          {secret}
        </div>
      ) : (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-foreground">
          <p className="font-medium">Rotation completed — secret not returned.</p>
          <p className="mt-1 text-muted-foreground">
            The server confirmed the rotation but did not return plaintext.
            This happens when the encryption key is not configured on the
            server side, so plaintext delivery is disabled by policy. Contact
            your operator if you expected the new secret here.
          </p>
        </div>
      )}

      <div className="rounded-md border bg-card p-3 text-xs space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Grace window</span>
          <span className="font-medium">
            {gracePeriodSeconds > 0
              ? formatGraceDuration(gracePeriodSeconds)
              : "none — previous secret invalidated immediately"}
          </span>
        </div>
        {grace ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Previous secret expires</span>
            <span className="font-medium">
              {grace.absolute}{" "}
              <span className="text-muted-foreground">({grace.relative})</span>
            </span>
          </div>
        ) : (
          <p className="text-muted-foreground">
            No grace window applied — your receivers must accept the new secret
            now.
          </p>
        )}
      </div>

      <DialogFooter>
        {secret && (
          <Button variant="outline" onClick={onCopy}>
            {copied ? <Check className="h-4 w-4 mr-1.5" /> : <Copy className="h-4 w-4 mr-1.5" />}
            {copied ? "Copied" : "Copy secret"}
          </Button>
        )}
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}
