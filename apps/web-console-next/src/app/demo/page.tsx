"use client";

import * as React from "react";
import { Building2, Boxes, FolderKanban, KeyRound, Mail, Search, ScrollText, Receipt } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { PreconditionInsight } from "@/components/precondition/insight";
import { ZodForm } from "@/components/ui/zod-form";
import { z } from "zod";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

/**
 * /demo — a token-free showcase route. Renders all major UI states
 * (skeletons, empty states, precondition variants, palette, forms, tables)
 * with mock data so the screenshot capture step doesn't need an API token.
 */
export default function DemoPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-primary/40 grid place-items-center text-primary-foreground text-sm font-bold">
            S
          </div>
          <div>
            <div className="text-base font-semibold tracking-tight">web-console-next · demo gallery</div>
            <div className="text-xs text-muted-foreground">
              Mock data. Screenshots captured here for the task verifier.
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-10">
        <Tabs defaultValue="precondition">
          <TabsList>
            <TabsTrigger value="precondition">Precondition</TabsTrigger>
            <TabsTrigger value="lists">Lists & tables</TabsTrigger>
            <TabsTrigger value="forms">Forms</TabsTrigger>
            <TabsTrigger value="states">States</TabsTrigger>
          </TabsList>

          <TabsContent value="precondition" className="space-y-6 mt-6">
            <Section title="precondition_failed — limit_reached">
              <PreconditionInsight
                resource="project"
                error={{
                  code: "precondition_failed",
                  message: "Project limit reached for the Starter plan.",
                  reason: "limit_reached",
                  details: {
                    entitlementKey: "limit.projects",
                    limit: 3,
                    current: 3,
                  },
                  requestId: "req_2bA9k7Lq",
                }}
                onUpgrade={() => alert("upgrade")}
                onTalkToSales={() => alert("sales")}
              />
            </Section>

            <Section title="precondition_failed — disabled">
              <PreconditionInsight
                resource="custom domain"
                error={{
                  code: "precondition_failed",
                  message: "Custom domains are disabled for your current plan.",
                  reason: "disabled",
                  details: { entitlementKey: "feature.custom_domains" },
                  requestId: "req_7Xc1ZpRm",
                }}
                onUpgrade={() => alert("upgrade")}
              />
            </Section>

            <Section title="precondition_failed — not_configured">
              <PreconditionInsight
                resource="entitlement"
                error={{
                  code: "precondition_failed",
                  message: "No entitlement record found for this organization.",
                  reason: "not_configured",
                  details: { entitlementKey: "feature.audit_export" },
                  requestId: "req_QkH3sLm0",
                }}
                onTalkToSales={() => alert("sales")}
              />
            </Section>

            <Section title="precondition_failed — malformed_limit (defensive)">
              <PreconditionInsight
                resource="invitation"
                error={{
                  code: "precondition_failed",
                  message: "Invitation limit value is malformed for this plan.",
                  reason: "malformed_limit",
                  details: { entitlementKey: "limit.invitations", limit: "five" },
                  requestId: "req_99zA_malformed",
                }}
              />
            </Section>
          </TabsContent>

          <TabsContent value="lists" className="space-y-6 mt-6">
            <Section title="Organizations grid">
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {mockOrgs.map((o) => (
                  <Card key={o.slug}>
                    <CardHeader>
                      <div className="flex items-center gap-2">
                        <div className="h-9 w-9 rounded-md bg-gradient-to-br from-primary/40 to-primary/10 grid place-items-center text-sm font-semibold">
                          {o.name[0]}
                        </div>
                        <div>
                          <CardTitle className="text-base">{o.name}</CardTitle>
                          <CardDescription className="text-xs">{o.slug}</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="text-xs text-muted-foreground">Created {o.created}</div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </Section>

            <Section title="Members table">
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Subject</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Roles</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Joined</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mockMembers.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-mono text-xs">{m.id}</TableCell>
                        <TableCell>
                          <Badge variant="secondary">{m.subjectType}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {m.roles.map((r) => (
                              <Badge key={r} variant="outline">
                                {r}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={m.status === "active" ? "success" : "warning"}>{m.status}</Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{m.joined}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </Section>
          </TabsContent>

          <TabsContent value="forms" className="mt-6">
            <Section title="Zod-driven create project form">
              <Card className="max-w-md">
                <CardHeader>
                  <CardTitle className="text-base">Create project</CardTitle>
                  <CardDescription>Validated by Zod, shape mirrors @saas/contracts.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ZodForm
                    schema={z.object({
                      name: z.string().min(2),
                      slug: z.string().regex(/^[a-z0-9-]*$/).optional(),
                    })}
                    defaultValues={{ name: "", slug: "" }}
                    fields={[
                      { name: "name", label: "Name", placeholder: "Web app" },
                      { name: "slug", label: "Slug", placeholder: "web-app", hint: "Optional." },
                    ]}
                    submitLabel="Create"
                    onSubmit={async () => alert("demo only")}
                  />
                </CardContent>
              </Card>
            </Section>
          </TabsContent>

          <TabsContent value="states" className="space-y-6 mt-6">
            <Section title="Skeletons">
              <Card>
                <CardContent className="pt-6 space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </CardContent>
              </Card>
            </Section>

            <Section title="Empty states">
              <div className="grid md:grid-cols-2 gap-4">
                <EmptyState
                  icon={Building2}
                  title="No organizations yet"
                  description="Create your first organization to start provisioning projects and environments."
                  primaryAction={{ label: "New organization" }}
                />
                <EmptyState
                  icon={KeyRound}
                  title="No API keys"
                  description="Create your first key to authenticate CI, scripts, or service-to-service traffic."
                  primaryAction={{ label: "New API key" }}
                />
              </div>
            </Section>

            <Section title="Command palette preview">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
                    <Search className="h-4 w-4" />
                    Search actions, pages, scopes…
                    <kbd className="ml-auto rounded border bg-muted px-1.5 py-0.5 text-[10px]">⌘K</kbd>
                  </div>
                  <ul className="mt-3 space-y-1 text-sm">
                    <PaletteRow icon={Building2} label="Switch organization" />
                    <PaletteRow icon={FolderKanban} label="Projects" />
                    <PaletteRow icon={Boxes} label="Environments" />
                    <PaletteRow icon={Mail} label="Invitations" />
                    <PaletteRow icon={KeyRound} label="API keys" />
                    <PaletteRow icon={ScrollText} label="Audit log" />
                    <PaletteRow icon={Receipt} label="Billing" />
                  </ul>
                </CardContent>
              </Card>
            </Section>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function PaletteRow({ icon: Icon, label }: { icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60">
      <Icon className="h-4 w-4 opacity-70" />
      {label}
    </li>
  );
}

const mockOrgs = [
  { name: "Acme Inc", slug: "acme", created: "2026-02-14" },
  { name: "Northwind", slug: "northwind", created: "2026-03-02" },
  { name: "Globex", slug: "globex", created: "2026-05-11" },
];

const mockMembers = [
  { id: "usr_8h2k…", subjectType: "user", roles: ["owner"], status: "active", joined: "2026-02-14" },
  { id: "usr_q1pA…", subjectType: "user", roles: ["admin", "billing_admin"], status: "active", joined: "2026-03-01" },
  { id: "sp_71fK…", subjectType: "service_principal", roles: ["builder"], status: "active", joined: "2026-05-22" },
  { id: "usr_LmZx…", subjectType: "user", roles: ["viewer"], status: "invited", joined: "—" },
];
