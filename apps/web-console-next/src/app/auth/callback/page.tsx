"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/session";
import { resolvePostAuthDestination } from "@/lib/last-org";
import { createClient } from "@/lib/api";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";

// Human-readable copy for the `error` codes the identity-worker callback may
// return in the URL fragment.
const ERROR_COPY: Record<string, string> = {
  access_denied: "Sign-in was cancelled.",
  email_required:
    "Your provider account has no email. Add an email with the provider, or sign in with an email code.",
  email_unverified:
    "Your provider email isn't verified. Verify it with the provider, or sign in with an email code.",
  exchange_failed: "Could not complete the handshake with the provider. Please try again.",
  identity_failed: "Could not read your profile from the provider. Please try again.",
  missing_code: "The provider did not return an authorization code. Please try again.",
  provider_unavailable: "This sign-in method is temporarily unavailable.",
  oauth_failed: "Something went wrong during sign-in. Please try again.",
  server_error: "Something went wrong on our side. Please try again.",
};

export default function OAuthCallbackPage() {
  const router = useRouter();
  const { setToken, target } = useSession();
  const { toast } = useToast();
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const raw = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(raw);
    const token = params.get("token");
    const err = params.get("error");

    // Scrub the fragment from the address bar / history so the token does not
    // linger in the URL.
    window.history.replaceState(null, "", window.location.pathname);

    if (token) {
      setToken(token);
      toast({ kind: "success", title: "Signed in" });
      void resolvePostAuthDestination(createClient(target, token)).then((dest) =>
        router.replace(dest),
      );
      return;
    }

    setError(err ?? "oauth_failed");
  }, [router, setToken, toast, target]);

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center px-4">
        <div className="w-full max-w-md space-y-4 text-center">
          <h1 className="text-lg font-semibold tracking-tight">Sign-in failed</h1>
          <p className="text-sm text-muted-foreground">
            {ERROR_COPY[error] ?? ERROR_COPY.oauth_failed}
          </p>
          <Button onClick={() => router.replace("/login")}>Back to sign in</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grid place-items-center text-sm text-muted-foreground">
      Completing sign-in…
    </div>
  );
}
