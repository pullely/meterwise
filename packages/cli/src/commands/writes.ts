// Write command handlers (Task 0101).
//
// Each handler is a thin adapter over an `@saas/sdk` resource client. The
// CLI never auto-generates an `Idempotency-Key`: every write command
// reads `--idempotency-key=KEY` from the parsed flags and forwards it
// verbatim into the SDK's `RequestOptions.idempotencyKey`. When the user
// omits the flag, the SDK sees `undefined` and the api-edge worker falls
// through without idempotency replay protection — the contract matches
// Stripe parity exactly (caller-owned key, no transparent generation).
//
// `--org=ORG_ID` overrides the persisted active-org for `org invite` only;
// the other write commands always resolve through `contextStore.activeOrgId`
// (see `resolveOrgId` below). When unset the handler throws
// `MissingOrgContextError` → exit 5 via `formatCliError`.
//
// Output:
//   - human mode: a single `key: value` block describing the new resource
//     (id + the most identifying field). No tables; writes return one row.
//   - json mode: the SDK response shape, verbatim.
//
// All handlers accept `--output=human|json` through `ctx.outputMode`; tests
// assert both modes for every new command.
//
// Errors propagate from the SDK as `MeterwiseError` subclasses and are
// translated to exit codes by `formatCliError` in the runner.

import type { CommandContext, CommandResult } from "../router.js";
import { formatOutput } from "../output/index.js";
import { UsageError } from "../errors.js";
import { resolveOrgId, readIdempotencyKey } from "./helpers.js";

/** Format a single-record write result. */
function emitRecord(
  ctx: CommandContext,
  record: Readonly<Record<string, string>>,
  jsonData: unknown,
  title: string,
): void {
  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: jsonData }));
    return;
  }
  ctx.stdout(formatOutput({ mode: "human", record, title }));
}

// ---------------------------------------------------------------------------
// org invite <email> [--role=ROLE] [--idempotency-key=KEY] [--org=ORG_ID]
// ---------------------------------------------------------------------------

export async function orgInviteCommand(ctx: CommandContext): Promise<CommandResult> {
  const email = ctx.args[0];
  if (email === undefined || email.length === 0) {
    throw new UsageError("usage: meterwise org invite <email> [--role=ROLE] [--idempotency-key=KEY] [--org=ORG_ID]");
  }
  const roleFlag = ctx.flags["role"];
  const role = typeof roleFlag === "string" && roleFlag.length > 0 ? roleFlag : "viewer";

  const orgId = await resolveOrgId(ctx, /* allowOverride */ true);
  const idempotencyKey = readIdempotencyKey(ctx);

  const sdk = await ctx.sdk();
  const result = await sdk.memberships.createInvitation(
    orgId,
    // The contracts type narrows `role` to `InvitationRole`; the api-edge
    // and contracts validate the value, so we forward the user's string
    // through without a CLI-side enum match (lets the server own the
    // catalogue and gives the user the canonical error if they typo).
    { email, role: role as "owner" | "admin" | "builder" | "viewer" | "billing_admin" },
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );
  const inv = result.invitation;
  emitRecord(
    ctx,
    {
      id: inv.id,
      email: inv.email,
      role: inv.role,
      status: inv.status,
      expiresAt: inv.expiresAt,
    },
    result,
    `Invitation created in ${orgId}`,
  );
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// project create <name> [--idempotency-key=KEY]
// ---------------------------------------------------------------------------

export async function projectCreateCommand(ctx: CommandContext): Promise<CommandResult> {
  const name = ctx.args[0];
  if (name === undefined || name.length === 0) {
    throw new UsageError("usage: meterwise project create <name> [--idempotency-key=KEY]");
  }
  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const idempotencyKey = readIdempotencyKey(ctx);

  const sdk = await ctx.sdk();
  const result = await sdk.projects.create(
    orgId,
    { name },
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );
  const p = result.project;
  emitRecord(
    ctx,
    { id: p.id, name: p.name, slug: p.slug, status: p.status },
    result,
    `Project created in ${orgId}`,
  );
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// env create <project-id> <name> [--idempotency-key=KEY]
//
// Routes through `client.environments.create()` — the SDK's typed
// EnvironmentsClient surface (added in Task 0102) which wraps the
// api-edge route `/v1/organizations/:orgId/projects/:projectId/environments`.
// ---------------------------------------------------------------------------

export async function envCreateCommand(ctx: CommandContext): Promise<CommandResult> {
  const projectId = ctx.args[0];
  const name = ctx.args[1];
  if (projectId === undefined || projectId.length === 0 || name === undefined || name.length === 0) {
    throw new UsageError("usage: meterwise env create <project-id> <name> [--idempotency-key=KEY]");
  }
  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const idempotencyKey = readIdempotencyKey(ctx);

  const sdk = await ctx.sdk();
  const result = await sdk.environments.create(
    orgId,
    projectId,
    { name },
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );

  const e = result.environment;
  emitRecord(
    ctx,
    {
      id: e.id,
      projectId: e.projectId,
      name: e.name,
      slug: e.slug,
      status: e.status,
    },
    result,
    `Environment created in ${projectId}`,
  );
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// api-key create <name> [--scope=SCOPE] [--idempotency-key=KEY]
//
// `<name>` becomes the API key `label`. `--scope=SCOPE` is interpreted as
// the role assigned to the service principal backing the key (the
// contract's `CreateApiKeyRequest.role` field); when omitted we default to
// `viewer` so the key is least-privileged. The user can also pass
// `--scope=builder|owner|...` to widen — the api-edge enforces RBAC on
// allowed values and surfaces a `validation_failed` error otherwise.
// ---------------------------------------------------------------------------

export async function apiKeyCreateCommand(ctx: CommandContext): Promise<CommandResult> {
  const name = ctx.args[0];
  if (name === undefined || name.length === 0) {
    throw new UsageError("usage: meterwise api-key create <name> [--scope=SCOPE] [--idempotency-key=KEY]");
  }
  const scopeFlag = ctx.flags["scope"];
  const role = typeof scopeFlag === "string" && scopeFlag.length > 0 ? scopeFlag : "viewer";

  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const idempotencyKey = readIdempotencyKey(ctx);

  const sdk = await ctx.sdk();
  const result = await sdk.apiKeys.create(
    orgId,
    { label: name, role },
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );
  const k = result.apiKey;
  emitRecord(
    ctx,
    {
      id: k.id,
      label: k.label,
      prefix: k.prefix,
      secret: k.secret,
      role: k.servicePrincipal.role,
    },
    result,
    `API key created in ${orgId} (save the secret — it will not be shown again)`,
  );
  return { exitCode: 0 };
}

// ---------------------------------------------------------------------------
// webhook create <url> [--event=EVENT ...] [--idempotency-key=KEY]
//
// `--event` may be passed multiple times (or as a comma-separated list);
// each value becomes a `WebhookSubscription` for the new endpoint. When no
// `--event` is supplied we create the endpoint only — it is then disabled
// from receiving anything until subscriptions are added (the worker default).
// We surface the chosen behaviour clearly in the human output.
// ---------------------------------------------------------------------------

function readEventFlags(flags: Readonly<Record<string, string | boolean>>): string[] {
  const raw = flags["event"];
  if (raw === undefined || raw === false) return [];
  if (raw === true) return [];
  // The simple parser collapses repeated `--event=X --event=Y` into the
  // last value; users wanting multi-event today should pass a
  // comma-separated string. This matches the existing flag shape (no
  // multi-value parser required) and is documented in the README.
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function webhookCreateCommand(ctx: CommandContext): Promise<CommandResult> {
  const url = ctx.args[0];
  if (url === undefined || url.length === 0) {
    throw new UsageError("usage: meterwise webhook create <url> [--event=EVENT[,EVENT2,...]] [--idempotency-key=KEY]");
  }
  const events = readEventFlags(ctx.flags);
  const orgId = await resolveOrgId(ctx, /* allowOverride */ false);
  const idempotencyKey = readIdempotencyKey(ctx);

  const sdk = await ctx.sdk();
  const created = await sdk.webhooks.createEndpoint(
    orgId,
    { url },
    idempotencyKey !== undefined ? { idempotencyKey } : {},
  );
  const endpoint = created.endpoint;

  // Wire up subscriptions for each event the user asked for. Subscription
  // creates are individually idempotency-keyed when the user supplied a
  // key — we suffix `:sub:<i>` so multiple subscriptions in a single
  // command invocation each get a stable, distinct key (Stripe pattern:
  // one logical operation = one root key, suffix per child write).
  const subscriptions: unknown[] = [];
  for (let i = 0; i < events.length; i++) {
    const eventType = events[i] ?? "";
    if (eventType.length === 0) continue;
    const subOpts =
      idempotencyKey !== undefined
        ? { idempotencyKey: `${idempotencyKey}:sub:${i}` }
        : {};
    const sub = await sdk.webhooks.createSubscription(
      orgId,
      { endpointId: endpoint.id, eventType },
      subOpts,
    );
    subscriptions.push(sub.subscription);
  }

  if (ctx.outputMode === "json") {
    ctx.stdout(
      formatOutput({
        mode: "json",
        data: { endpoint, subscriptions },
      }),
    );
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        record: {
          id: endpoint.id,
          url: endpoint.url,
          status: endpoint.status,
          subscriptions: events.length === 0 ? "(none — add with `webhook subscribe`)" : events.join(","),
        },
        title: `Webhook endpoint created in ${orgId}`,
      }),
    );
  }
  return { exitCode: 0 };
}
