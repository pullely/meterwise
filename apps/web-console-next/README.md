# @saas/web-console-next

Next.js 15 + [opennextjs/cloudflare](https://github.com/opennextjs/opennextjs-cloudflare) delivery of the Meterwise web console.

Wired against the same `@saas/contracts` typed envelope as `apps/web-console`,
deployed via the same `cloudflare-pages-turbo` orun composition (with
`outputDir: .open-next/assets` instead of `dist/`).

## Scripts

```bash
pnpm -F @saas/web-console-next dev          # next dev on :3001
pnpm -F @saas/web-console-next typecheck    # tsc --noEmit
pnpm -F @saas/web-console-next lint         # eslint
pnpm -F @saas/web-console-next build        # next build (standalone) + opennextjs-cloudflare build
```

The `build` script runs Next's standalone build (configured via
`output: "standalone"` + `outputFileTracingRoot` in `next.config.mjs`) and
then invokes `opennextjs-cloudflare build --skipBuild
--skipWranglerConfigCheck`, which reads `.next/standalone/**` and emits the
Cloudflare Pages-compatible bundle into `.open-next/`:

- `.open-next/assets/**` — static assets the `cloudflare-pages-turbo`
  orun component publishes (matches `outputDir` in `component.yaml`).
- `.open-next/worker.js` — Pages Function entrypoint, referenced from
  `wrangler.jsonc#main`.

`open-next.config.ts` keeps the in-memory `dummy` overrides for the
incremental cache / tag cache / queue — this app has no R2/KV/D1 bindings
and runs fully session-authenticated, so no persistent caching layer is
needed.

## Parity vs. apps/web-console

| Surface                     | web-console (Vite) | web-console-next (Next 15) |
|-----------------------------|--------------------|----------------------------|
| Login (email-code)          | ✅ inline form     | ✅ Zod form + tabs         |
| Login (bearer token paste)  | ✅                 | ✅                         |
| Org listing                 | ✅                 | ✅ card grid               |
| Create organization         | ✅                 | ✅ Zod dialog form         |
| Projects list               | ✅                 | ✅ card grid + status      |
| Create project              | ✅                 | ✅ Zod dialog form         |
| Members list                | ✅                 | ✅ table + role badges     |
| Remove member               | ✅                 | ✅                         |
| Invitations list            | ✅                 | ✅ table + status badges   |
| Create invitation           | ✅                 | ✅ Zod dialog form (role enum) |
| Revoke invitation           | ✅                 | ✅                         |
| API keys list               | ✅                 | ✅ table                   |
| Create API key + one-time secret reveal | ✅      | ✅ reveal modal + copy     |
| Revoke API key              | ✅                 | ✅                         |
| Environments list           | ✅                 | ✅ card grid               |
| Create environment          | ✅                 | ✅ Zod dialog form         |
| Environment detail          | (basic)            | ✅ identity card           |
| Audit log                   | ✅                 | ✅ category filter         |
| Billing (plan/ents/invoices)| ✅                 | ✅ + precondition_failed UX|
| Config / org identifiers    | partial            | ✅                         |
| Target switching            | ✅                 | ✅ (sidebar + palette)     |
| Dark mode                   | ❌                 | ✅ next-themes (default)   |
| Empty states + skeletons    | minimal            | ✅ across every list       |
| Cmd-K command palette       | ❌                 | ✅                         |
| URL-driven scope            | sessionStorage     | ✅ `useParams`             |
| Designed precondition_failed UX | ❌             | ✅ four reason-coded shapes|

## Notable design choices

- **Tailwind 3.4 + Next 15.0 stable** rather than Tailwind v4-beta + Next 15 alpha (risk reduction).
- **Design system co-located** in `src/components/ui/`; promoting to `packages/ui` is a future task.
- **URL is the source of truth for scope**: `/orgs/[orgSlug]/projects/[projectSlug]/environments/[envSlug]`. We never cache scope in storage so cross-tab tenant isolation is enforced.
- **Per-target `ApiClient` instance** constructed by `SessionProvider`, not a module singleton.
- **Error envelope preserves `meta.requestId`** on the failure branch so `PreconditionInsight` can always surface request IDs.
- **`NEXT_PUBLIC_DEPLOY_ENV`** mirrors the old `VITE_DEPLOY_ENV` build-time lock — when set, the target switcher is hidden.
- **`/demo`** is a token-free showcase route used for verifier screenshots.
- **`ZodForm`** is the canonical contracts→form proof: a single Zod schema feeds validation, types, and the rendered fields.

## Designed `precondition_failed` UX

Reason codes (per `ai/context/current.md`):

- `limit_reached` — entitlement quota exhausted; offer upgrade.
- `disabled` — feature exists on a higher plan; offer upgrade.
- `not_configured` — no entitlement record; offer "talk to sales".
- `malformed_limit` — defensive; surfaces request ID for support escalation.

All four shapes are rendered on `/demo` for screenshot evidence.

## Deployment

Identical orun composition pattern to `apps/web-console`:

- `spec.type: cloudflare-pages-turbo`
- `outputDir: .open-next/assets` (opennextjs/cloudflare output)
- `environmentBuildVar: NEXT_PUBLIC_DEPLOY_ENV` (was `VITE_DEPLOY_ENV`)
- Per-env Cloudflare Pages projects: `meterwise-web-console-next-{dev,stage,prod}`
- Smoke probe identical to the existing console.

Verification is via the same `verify`/`deploy` profile split, so this app
fits cleanly into the existing platform pipeline.
