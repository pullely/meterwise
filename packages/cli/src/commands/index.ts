// Pilot read-only command handlers.
//
// Each handler is a thin adapter over the SDK + the output formatter. Per
// PR Boundary §3 this PR ships only:
//   - login / logout / whoami   (auth)
//   - org list / org use / org members
//   - project list
//
// Write commands (org invite, project create, env create, …) are Task 0101.

import type { CommandContext, CommandResult } from "../router.js";
import { formatOutput } from "../output/index.js";
import { MissingOrgContextError, UsageError } from "../errors.js";
import { loginFlow } from "../auth/login.js";
import { whoamiFlow } from "../auth/whoami.js";
import { logoutFlow } from "../auth/logout.js";
import { readBearerTokenFromStdin } from "../prompt.js";

export async function loginCommand(ctx: CommandContext): Promise<CommandResult> {
  const apiUrlFlag = ctx.flags["api-url"];
  const tokenFlag = ctx.flags["token"];
  const apiUrl = typeof apiUrlFlag === "string" ? apiUrlFlag : undefined;
  const token = typeof tokenFlag === "string" ? tokenFlag : undefined;

  await loginFlow({
    ...(apiUrl !== undefined ? { apiUrl } : {}),
    ...(token !== undefined ? { token } : {}),
    outputMode: ctx.outputMode,
    tokenStore: ctx.tokenStore,
    contextStore: ctx.contextStore,
    stdout: ctx.stdout,
    readToken: () => readBearerTokenFromStdin(),
  });
  return { exitCode: 0 };
}

export async function logoutCommand(ctx: CommandContext): Promise<CommandResult> {
  await logoutFlow({
    outputMode: ctx.outputMode,
    tokenStore: ctx.tokenStore,
    contextStore: ctx.contextStore,
    stdout: ctx.stdout,
  });
  return { exitCode: 0 };
}

export async function whoamiCommand(ctx: CommandContext): Promise<CommandResult> {
  await whoamiFlow({
    outputMode: ctx.outputMode,
    tokenStore: ctx.tokenStore,
    contextStore: ctx.contextStore,
    stdout: ctx.stdout,
  });
  return { exitCode: 0 };
}

export async function orgListCommand(ctx: CommandContext): Promise<CommandResult> {
  const sdk = await ctx.sdk();
  const result = await sdk.organizations.list();
  const cliCtx = await ctx.contextStore.load();
  const active = cliCtx.activeOrgId ?? null;

  const rows = result.organizations.map((org) => ({
    active: org.id === active ? "*" : "",
    id: org.id,
    name: org.name,
    slug: org.slug,
  }));

  if (ctx.outputMode === "json") {
    ctx.stdout(
      formatOutput({
        mode: "json",
        data: {
          activeOrgId: active,
          organizations: result.organizations,
        },
      }),
    );
  } else {
    ctx.stdout(
      formatOutput({
        mode: "human",
        columns: ["active", "id", "name", "slug"],
        rows,
      }),
    );
  }

  return { exitCode: 0 };
}

export async function orgUseCommand(ctx: CommandContext): Promise<CommandResult> {
  const orgId = ctx.args[0];
  if (orgId === undefined || orgId.length === 0) {
    throw new UsageError("usage: meterwise org use <org-id>");
  }
  // Validate the org exists by hitting the SDK; surface 404 as
  // MeterwiseError → friendly CLI message.
  const sdk = await ctx.sdk();
  await sdk.organizations.get(orgId);
  await ctx.contextStore.setActiveOrg(orgId);
  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: { activeOrgId: orgId } }));
  } else {
    ctx.stdout(`✓ Active organization set to ${orgId}.`);
  }
  return { exitCode: 0 };
}

export async function orgMembersCommand(ctx: CommandContext): Promise<CommandResult> {
  const cliCtx = await ctx.contextStore.load();
  const orgId = cliCtx.activeOrgId;
  if (orgId === undefined || orgId.length === 0) {
    throw new MissingOrgContextError();
  }
  const sdk = await ctx.sdk();
  const result = await sdk.memberships.listMembers(orgId);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }

  const rows = result.members.map((m) => ({
    id: m.id,
    subject: `${m.subjectType}:${m.subjectId}`,
    roles: m.roles.map((r) => r.role).join(","),
    status: m.status,
  }));
  ctx.stdout(
    formatOutput({
      mode: "human",
      columns: ["id", "subject", "roles", "status"],
      rows,
      title: `Members of ${orgId}`,
    }),
  );
  return { exitCode: 0 };
}

export async function projectListCommand(ctx: CommandContext): Promise<CommandResult> {
  const cliCtx = await ctx.contextStore.load();
  const orgId = cliCtx.activeOrgId;
  if (orgId === undefined || orgId.length === 0) {
    throw new MissingOrgContextError();
  }
  const sdk = await ctx.sdk();
  const result = await sdk.projects.list(orgId);

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }

  const rows = result.projects.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    status: p.status,
  }));
  ctx.stdout(
    formatOutput({
      mode: "human",
      columns: ["id", "name", "slug", "status"],
      rows,
      title: `Projects in ${orgId}`,
    }),
  );
  return { exitCode: 0 };
}
