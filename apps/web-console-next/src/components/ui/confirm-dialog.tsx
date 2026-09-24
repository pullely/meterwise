"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./dialog";
import { Button } from "./button";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One consequence sentence — what happens and why it matters. */
  description: React.ReactNode;
  /** The resource being acted on, echoed verbatim so the user can verify it. */
  resourceName?: string | undefined;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive styling by default — this primitive exists for those flows. */
  destructive?: boolean;
  /**
   * Runs on confirm. While a returned promise is pending the confirm button
   * shows its in-flight state and the dialog refuses to close; the dialog
   * closes itself when the promise resolves. Rejections also close — error
   * surfacing (toasts) is the caller's job, same as every other mutation.
   */
  onConfirm: () => void | Promise<void>;
}

/**
 * Designed replacement for `window.confirm()` on destructive actions:
 * consequence sentence, resource-name echo, destructive-styled action with
 * loading state, and Radix focus handling (trap + restore to trigger).
 * Initial focus lands on Cancel — the safe default.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  resourceName,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = true,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = React.useState(false);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          // Safe default: focus Cancel, not the destructive action.
          e.preventDefault();
          cancelRef.current?.focus();
        }}
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onPointerDownOutside={(e) => busy && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {resourceName ? (
          <div className="rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs break-all">
            {resourceName}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            ref={cancelRef}
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            loading={busy}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
