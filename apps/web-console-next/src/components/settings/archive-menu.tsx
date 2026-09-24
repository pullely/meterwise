"use client";

import * as React from "react";
import { MoreVertical, Archive } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Corner "⋯" menu with an Archive action + confirm dialog, shared by the
 * projects and environments lists. The parent owns the optimistic list
 * mutation; this component only gates the confirm and invokes `onConfirm`.
 * Stops click propagation so it can live inside a card-level link.
 */
export function ArchiveMenu({
  resourceLabel,
  name,
  onConfirm,
}: {
  resourceLabel: string;
  name: string;
  onConfirm: () => Promise<void> | void;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  return (
    <div
      onClick={(e) => {
        // Prevent the surrounding card link from navigating.
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`${resourceLabel} actions`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <MoreVertical className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            className="text-destructive"
            onSelect={(e) => {
              e.preventDefault();
              setOpen(true);
            }}
          >
            <Archive className="h-4 w-4 opacity-70" /> Archive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {resourceLabel}?</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">{name}</span> will be archived.
              It will no longer appear in active lists.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Archiving…" : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
