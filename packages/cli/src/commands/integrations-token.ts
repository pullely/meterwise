// `meterwise integrations github token --repos=ID[,ID…] --permissions=key:level[,key:level…] [--org=ORG_ID]`
//
// CLI leg of the IG4 token broker: exchanges the caller's control-plane
// credential for a short-lived, repo-scoped GitHub installation token.
// The token prints exactly once (or as JSON) — it is never stored.

import type { CommandContext, CommandResult } from "../router.js";
import { formatOutput } from "../output/index.js";
import { UsageError } from "../errors.js";
import { resolveOrgId } from "./helpers.js";

function parseRepos(flag: unknown): string[] {
  if (typeof flag !== "string" || !flag.trim()) {
    throw new UsageError("--repos is required (comma-separated provider repository ids)");
  }
  const repos = flag
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (repos.length === 0) throw new UsageError("--repos must name at least one repository id");
  return repos;
}

function parsePermissions(flag: unknown): Record<string, "read" | "write"> {
  if (typeof flag !== "string" || !flag.trim()) {
    throw new UsageError('--permissions is required, e.g. --permissions=contents:read,checks:write');
  }
  const permissions: Record<string, "read" | "write"> = {};
  for (const entry of flag.split(",")) {
    const [key, level] = entry.split(":").map((p) => p.trim());
    if (!key || (level !== "read" && level !== "write")) {
      throw new UsageError(`Invalid permission "${entry}" — use key:read or key:write`);
    }
    permissions[key] = level;
  }
  return permissions;
}

export async function integrationsGithubTokenCommand(
  ctx: CommandContext,
): Promise<CommandResult> {
  const repositories = parseRepos(ctx.flags["repos"]);
  const permissions = parsePermissions(ctx.flags["permissions"]);

  const orgId = await resolveOrgId(ctx, true);
  const client = await ctx.sdk();
  const result = await client.integrations.issueGithubToken(orgId, {
    repositories,
    permissions,
  });

  if (ctx.outputMode === "json") {
    ctx.stdout(formatOutput({ mode: "json", data: result }));
    return { exitCode: 0 };
  }
  ctx.stdout(
    formatOutput({
      mode: "human",
      title: `GitHub installation token (expires ${result.expiresAt})`,
      columns: ["field", "value"],
      rows: [
        { field: "token", value: result.token },
        { field: "repositories", value: result.repositories.join(", ") },
        {
          field: "permissions",
          value: Object.entries(result.permissions)
            .map(([k, v]) => `${k}:${v}`)
            .join(", "),
        },
      ],
    }),
  );
  return { exitCode: 0 };
}
