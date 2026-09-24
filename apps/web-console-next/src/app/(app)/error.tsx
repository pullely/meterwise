"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Segment error boundary for the authenticated app. Turns an unhandled
 * client-side exception on any page into a recoverable card (instead of the
 * bare "Application error" white-screen), and — crucially — gives an escape
 * back to the org picker so a single bad org/page can't trap the user.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  React.useEffect(() => {
    // Surface for diagnostics; the boundary already prevents the crash.
    console.error("App segment error:", error);
  }, [error]);

  return (
    <div className="grid min-h-[60vh] place-items-center px-4">
      <div className="w-full max-w-md space-y-4 text-center">
        <div className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            This page hit an unexpected error. You can retry, or head back to your organizations.
          </p>
          {error.digest && (
            <p className="pt-1 font-mono text-[11px] text-muted-foreground/70">ref: {error.digest}</p>
          )}
        </div>
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" onClick={() => reset()}>
            Try again
          </Button>
          <Button onClick={() => router.push("/orgs")}>Back to organizations</Button>
        </div>
      </div>
    </div>
  );
}
