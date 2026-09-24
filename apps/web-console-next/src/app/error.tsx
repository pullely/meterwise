"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/**
 * Root segment error boundary — catches errors that escape the app shell
 * (e.g. thrown by `(app)/layout.tsx` itself). Rendered inside the root layout,
 * so the app's styles are available. Keeps a single page fault from
 * white-screening the whole console.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  React.useEffect(() => {
    console.error("Root error boundary:", error);
  }, [error]);

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">
          The console hit an unexpected error. Retry, or return to your organizations.
        </p>
        {error.digest && (
          <p className="font-mono text-[11px] text-muted-foreground/70">ref: {error.digest}</p>
        )}
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm hover:bg-accent"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => router.push("/orgs")}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm text-primary-foreground hover:bg-primary/90"
          >
            Back to organizations
          </button>
        </div>
      </div>
    </div>
  );
}
