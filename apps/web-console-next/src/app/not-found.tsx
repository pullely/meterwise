import Link from "next/link";
import { Compass } from "lucide-react";

/**
 * Designed 404 — every unmatched console URL lands here instead of the
 * unbranded Next.js default. Server component (no session hooks): the route
 * may be hit logged-out, and `/orgs` re-routes through the auth guard anyway.
 */
export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-md space-y-5 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Compass className="h-6 w-6" aria-hidden />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold tracking-tight">Page not found</h1>
          <p className="text-sm text-muted-foreground">
            That address doesn&apos;t match anything in the console. It may have
            moved, or the link may be stale.
          </p>
        </div>
        <div className="flex items-center justify-center gap-2">
          <Link
            href="/orgs"
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
          >
            Back to organizations
          </Link>
          <Link
            href="/account"
            className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
          >
            Account
          </Link>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground/70">404 · not_found</p>
      </div>
    </div>
  );
}
