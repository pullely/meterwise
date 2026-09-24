# `@saas/sdk`

Meterwise TypeScript SDK — typed, dependency-free, runtime-agnostic client
for the Meterwise control plane API.

## Install (workspace)

This package is internal to the `meterwise` monorepo. Add it as a
workspace dependency:

```jsonc
// package.json of a consumer (e.g. apps/web-console, packages/cli)
{
  "dependencies": {
    "@saas/sdk": "workspace:*"
  }
}
```

Then `pnpm install` from the repo root.

## Getting started

```ts
import { Meterwise } from "@saas/sdk";

const client = new Meterwise({
  baseUrl: "https://api.meterwise.app",
  auth: { kind: "bearer", token: process.env["METERWISE_TOKEN"]! },
});

const { organizations } = await client.organizations.list();
console.log(organizations);
```

## Idempotency

POST routes accept a caller-owned `Idempotency-Key`. The SDK does **not**
auto-generate one (Stripe parity — the key is opaque to the server and
caller-controlled):

```ts
import { randomUUID } from "node:crypto"; // or your own source

const { project } = await client.projects.create(
  "org_1",
  { name: "Web app" },
  { idempotencyKey: randomUUID() },
);
```

If the create call fails mid-flight, retry with the same key — the api-edge
replay store guarantees no double-create.

## Error handling

All non-2xx responses throw a typed subclass of `MeterwiseError`. Branch on
the class (or on `error.code`):

```ts
import {
  RateLimitError,
  ValidationError,
  Meterwise,
} from "@saas/sdk";

try {
  await client.organizations.create({ name: "" });
} catch (err) {
  if (err instanceof ValidationError) {
    console.warn("invalid input", err.fields);
  } else if (err instanceof RateLimitError) {
    console.warn(`back off ${err.retryAfterSeconds}s, scope=${err.scope}`);
    console.warn("org window", err.orgWindow);
    console.warn("identity window", err.identityWindow);
  } else {
    throw err;
  }
}
```

The full hierarchy:

| Class                       | `code`                | Default status |
| --------------------------- | --------------------- | -------------- |
| `BadRequestError`           | `bad_request`         | 400            |
| `UnauthenticatedError`      | `unauthenticated`     | 401            |
| `ForbiddenError`            | `forbidden`           | 403            |
| `NotFoundError`             | `not_found`           | 404            |
| `UnsupportedError`          | `unsupported`         | 405 / 415      |
| `ConflictError`             | `conflict`            | 409            |
| `PreconditionFailedError`   | `precondition_failed` | 412            |
| `ValidationError`           | `validation_failed`   | 422            |
| `RateLimitError`            | `rate_limited`        | 429            |
| `InternalError`             | `internal_error`      | 500+           |
| `MeterwiseError` (base)   | _any_                 | _any_          |

Unknown error codes (forward-compatible — e.g. a future `quota_exceeded`)
decode to the base `MeterwiseError` carrying the raw envelope. Non-JSON 5xx
responses (gateway HTML, empty body) decode to `InternalError` with
`message: "HTTP <status>"`.

## Request options

Every method accepts a final `RequestOptions` argument:

| Field            | Type                       | Notes                                                   |
| ---------------- | -------------------------- | ------------------------------------------------------- |
| `idempotencyKey` | `string`                   | Sent as `Idempotency-Key`. Caller-owned. POST only.     |
| `signal`         | `AbortSignal`              | Forwarded to the underlying `fetch`.                    |
| `requestId`      | `string`                   | Sent as `x-request-id`. Auto-generated when omitted.    |
| `headers`        | `Record<string, string>`   | Per-request header overrides (last-write-wins).         |

## Environment compatibility

The SDK is runtime-agnostic. The same source runs on:

| Runtime              | Status     | Notes                                                   |
| -------------------- | ---------- | ------------------------------------------------------- |
| Browsers (modern)    | ✅ Tier 1  | Uses `fetch`, `Headers`, `URL`, `crypto.randomUUID`.    |
| Node ≥ 20            | ✅ Tier 1  | Native `fetch` / Web Crypto on the global.              |
| Cloudflare Workers   | ✅ Tier 1  | No `node:*` imports; pure Web Platform.                 |
| Bun                  | ✅ Tier 1  | Native `fetch` + Web Crypto.                            |

A custom `fetch` implementation can be injected via `new Meterwise({ fetch })`.
This is mostly useful for tests; production callers should rely on the platform
global.

## Resource surface

This is the pilot surface. Task 0099 will fan out the remaining resource
clients (memberships, api-keys, webhooks, metering, billing, events,
security-events, config, notifications) using the same pattern.

```ts
client.organizations.list()
client.organizations.get(orgId)
client.organizations.create({ name }, { idempotencyKey })

client.projects.list(orgId)
client.projects.get(orgId, projectId)
client.projects.create(orgId, { name }, { idempotencyKey })
client.projects.archive(orgId, projectId)
```

All request / response types are re-exported from this package; consumers do
not need to import `@saas/contracts` directly.

## Telemetry

A first-class telemetry hook is **not** in this PR; the transport seam
(`Transport`) is left clean enough that wrapping it with span emission is a
non-breaking follow-up.

## Testing

```bash
pnpm --filter @saas/sdk typecheck
pnpm --filter @saas/sdk lint
pnpm --filter @saas/sdk test
```

## Constraints (carried from the PR)

- Zero runtime dependencies (other than the `@saas/contracts` workspace type
  re-exports).
- No lint-disable directives, ts-ignore / ts-expect-error escape hatches, or
  unsafe casts (Track A/B hazard ban).
- No `node:*` imports.
- No imports from `apps/**` or any worker source.

## See also

- `specs/core/contracts/api-guidelines.md` — error envelope, Idempotency-Key,
  rate-limit headers, request-id conventions.
- `specs/roadmap.md` — leg B4 (`packages/sdk` + `packages/cli`).
- `packages/contracts/src/errors.ts` — canonical `ERROR_CODES`.
