"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/lib/session";
import { resolvePostAuthDestination } from "@/lib/last-org";
import { wrap, createClient } from "@/lib/api";
import { CONSOLE_TITLE } from "@/lib/app-config";
import { useToast } from "@/components/ui/toast";
import { ZodForm } from "@/components/ui/zod-form";
import type { OAuthProviderInfo } from "@saas/contracts/auth";

const emailSchema = z.object({
  email: z.string().email("Enter a valid email"),
});

const PROVIDER_ICONS: Record<string, React.ReactNode> = {
  github: (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  ),
  google: (
    <svg viewBox="0 0 18 18" aria-hidden="true" className="h-4 w-4">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.02-2.34z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 9 0 9 9 0 0 0 .96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  ),
};

export default function LoginPage() {
  const router = useRouter();
  const { client, target, availableTargets, setTarget, setToken, isLocked } = useSession();
  const { toast } = useToast();
  const [stage, setStage] = React.useState<"email" | "code">("email");
  const [challengeId, setChallengeId] = React.useState<string | null>(null);
  const [emailHint, setEmailHint] = React.useState<string>("");
  const [debugCode, setDebugCode] = React.useState<string | null>(null);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [tokenInput, setTokenInput] = React.useState("");
  const [oauthProviders, setOauthProviders] = React.useState<OAuthProviderInfo[]>([]);

  // Discover configured OAuth providers so we only render buttons that work.
  React.useEffect(() => {
    let cancelled = false;
    wrap(() => client.auth.listOAuthProviders()).then((r) => {
      if (!cancelled && r.ok) setOauthProviders(r.data.providers);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const startOAuth = React.useCallback(
    (providerId: string) => {
      if (typeof window === "undefined") return;
      const returnTo = `${window.location.origin}/auth/callback`;
      window.location.href = client.auth.oauthStartUrl(providerId, returnTo);
    },
    [client],
  );

  return (
    <div className="min-h-screen grid place-items-center bg-gradient-to-br from-background via-background to-primary/5 px-4">
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-primary to-primary/40 grid place-items-center text-primary-foreground font-bold">
            S
          </div>
          <div>
            <div className="text-base font-semibold tracking-tight">{CONSOLE_TITLE}</div>
            <div className="text-xs text-muted-foreground">
              {isLocked ? `locked to ${target.name}` : `target: ${target.name}`}
            </div>
          </div>
        </div>

        <Card className="animate-fade-in">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Use email code or paste a bearer token for prod testing.</CardDescription>
          </CardHeader>
          <CardContent>
            {oauthProviders.length > 0 && (
              <div className="space-y-2 pb-4">
                {oauthProviders.map((p) => (
                  <Button
                    key={p.id}
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => startOAuth(p.id)}
                  >
                    {PROVIDER_ICONS[p.id] ?? null}
                    Continue with {p.displayName}
                  </Button>
                ))}
                <div className="relative py-1">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center">
                    <span className="bg-card px-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                      or
                    </span>
                  </div>
                </div>
              </div>
            )}
            <Tabs defaultValue="email" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="email">Email code</TabsTrigger>
                <TabsTrigger value="token">Bearer token</TabsTrigger>
              </TabsList>

              <TabsContent value="email" className="space-y-3 pt-2">
                {stage === "email" && (
                  <ZodForm
                    schema={emailSchema}
                    defaultValues={{ email: "" }}
                    fields={[
                      {
                        name: "email",
                        label: "Email",
                        type: "email",
                        autoComplete: "email",
                        placeholder: "you@company.com",
                      },
                    ]}
                    submitLabel="Send code"
                    onSubmit={async ({ email }) => {
                      const r = await wrap(() => client.auth.loginStart({ email }));
                      if (!r.ok) {
                        toast({ kind: "error", title: "Login failed", description: r.error.message });
                        return;
                      }
                      setChallengeId(r.data.challengeId);
                      setEmailHint(r.data.delivery.emailHint);
                      setDebugCode(r.data.delivery.code ?? null);
                      setStage("code");
                    }}
                  />
                )}
                {stage === "code" && (
                  <div className="space-y-3">
                    <div className="rounded-md border bg-muted/30 p-3 text-xs">
                      Code sent to <strong>{emailHint}</strong>.
                      {debugCode && (
                        <>
                          {" "}
                          <span className="text-muted-foreground">debug code:</span>{" "}
                          <code className="font-mono">{debugCode}</code>
                        </>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="code">Verification code</Label>
                      <Input
                        id="code"
                        autoComplete="one-time-code"
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        placeholder="123456"
                      />
                    </div>
                    <div className="flex justify-between">
                      <Button variant="ghost" onClick={() => setStage("email")}>
                        Back
                      </Button>
                      <Button
                        loading={busy}
                        disabled={code.length < 4}
                        onClick={async () => {
                          if (!challengeId) return;
                          setBusy(true);
                          const r = await wrap(() =>
                            client.auth.loginComplete({ challengeId, code }),
                          );
                          setBusy(false);
                          if (!r.ok) {
                            toast({ kind: "error", title: "Code rejected", description: r.error.message });
                            return;
                          }
                          setToken(r.data.token);
                          toast({ kind: "success", title: "Signed in" });
                          router.push(
                            await resolvePostAuthDestination(createClient(target, r.data.token)),
                          );
                        }}
                      >
                        Sign in
                      </Button>
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="token" className="space-y-3 pt-2">
                <div className="space-y-1.5">
                  <Label htmlFor="bearer">Bearer token</Label>
                  <Input
                    id="bearer"
                    type="password"
                    placeholder="paste prod token…"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Stored locally only. Use this path for prod parity testing.
                  </p>
                </div>
                <Button
                  className="w-full"
                  disabled={!tokenInput}
                  onClick={async () => {
                    setToken(tokenInput);
                    toast({ kind: "success", title: "Token set" });
                    router.push(
                      await resolvePostAuthDestination(createClient(target, tokenInput)),
                    );
                  }}
                >
                  Continue
                </Button>
              </TabsContent>
            </Tabs>

            {!isLocked && availableTargets.length > 1 && (
              <div className="mt-4 border-t pt-3 space-y-1.5">
                <Label className="text-xs">API target</Label>
                <div className="flex flex-wrap gap-2">
                  {availableTargets.map((t) => (
                    <Button
                      key={t.name}
                      size="sm"
                      variant={t.name === target.name ? "default" : "outline"}
                      onClick={() => setTarget(t)}
                    >
                      {t.name}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-[11px] text-muted-foreground">
          By signing in you agree to the Acceptable Use Policy.
        </p>
      </div>
    </div>
  );
}
