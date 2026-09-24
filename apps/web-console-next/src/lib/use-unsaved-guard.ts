"use client";

import * as React from "react";

/**
 * Warn before the browser unloads (reload, tab close, external nav) while a
 * form has unsaved edits. In-app navigations are not intercepted: the App
 * Router has no public route-change veto, and the dirty forms here already
 * surface an explicit Save / Discard pair, so the guard targets the one exit
 * path where work is silently destroyed.
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  React.useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Chrome requires returnValue to be set for the prompt to appear.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
}
