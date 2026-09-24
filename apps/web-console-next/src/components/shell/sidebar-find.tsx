"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { usePalette } from "./command-palette";

/**
 * "Find…" search at the top of the sidebar — opens the ⌘K command palette
 * (search + navigation + actions). Mirrors Vercel's sidebar search field.
 */
export function SidebarFind({ onOpen }: { onOpen?: () => void } = {}) {
  const palette = usePalette();
  return (
    <button
      type="button"
      onClick={() => {
        onOpen?.();
        palette.open();
      }}
      className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Search className="h-4 w-4" />
      <span className="flex-1 text-left">Find…</span>
      <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
    </button>
  );
}
