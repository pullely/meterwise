// GET /ingress/github/setup — the install-callback half of the tenancy
// keystone (design §4). GitHub redirects the installing user here with an
// installation_id and (when the flow started from our console) the signed
// state. The org binding comes ONLY from our state:
//
//   valid single-use state  → resolve pending connection → verify install
//                             as the App → bind + activate (+ event)
//   anything else           → record the installation as ORPHANED
//                             (admin-visible, never auto-bound) — fail closed
//
// The response is a tiny self-contained HTML page: the console opens the
// install flow in a popup and polls the connection until it activates, so
// the page only needs to tell the human what happened and close itself.

import type { Env } from "../env.js";
import type { SqlExecutor } from "@saas/db/d1";
import type { FetchLike } from "../github-app.js";
import { INTEGRATION_EVENT_TYPES } from "@saas/contracts/integrations";
import { createIntegrationsRepository, type IntegrationsRepository } from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/d1";
import { asUuid } from "@saas/db/ids";
import { generateUuid } from "../ids.js";
import { getConfiguredProvider } from "../providers/registry.js";
import { hashStateNonce, verifyConnectState } from "../state.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function popupPage(kind: "success" | "error", title: string, message: string): Response {
  const tone = kind === "success" ? "#16a34a" : "#dc2626";
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;background:#0a0a0a;color:#fafafa;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{max-width:24rem;text-align:center;padding:2rem}
  .dot{width:.75rem;height:.75rem;border-radius:9999px;background:${tone};margin:0 auto 1rem}
  h1{font-size:1rem;font-weight:600;margin:0 0 .5rem}
  p{font-size:.875rem;color:#a1a1aa;margin:0}
</style></head>
<body><div class="card"><div class="dot"></div>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)} You can close this window.</p></div>
<script>setTimeout(function(){window.close()},2500)</script>
</body></html>`;
  return new Response(html, {
    status: kind === "success" ? 200 : 400,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Record an unsolicited/unbindable installation as orphaned (fail closed). */
async function recordOrphan(
  repo: IntegrationsRepository,
  env: Env,
  installationId: number,
  fetchImpl?: FetchLike,
): Promise<void> {
  let facts: {
    accountLogin?: string | null;
    accountId?: number | null;
    accountType?: string | null;
    repositorySelection?: string | null;
    permissions?: Record<string, unknown> | null;
    events?: unknown[] | null;
  } = {};
  const configured = getConfiguredProvider(env, "github", fetchImpl);
  if (configured) {
    const fetched = await configured.provider.completeConnect({
      installationId,
      nowMs: Date.now(),
    });
    if (fetched) facts = fetched;
  }
  await repo.upsertGithubInstallation({
    id: generateUuid(),
    connectionId: null,
    installationId,
    accountLogin: facts.accountLogin ?? null,
    accountId: facts.accountId ?? null,
    accountType: facts.accountType ?? null,
    repositorySelection: facts.repositorySelection ?? null,
    permissions: facts.permissions ?? null,
    events: facts.events ?? null,
  });
}

const LINK_FAILED_MESSAGE =
  "We couldn't link this installation to an organization. Start the connection again from your organization's Integrations settings.";

/** Test seam: inject a fake executor / GitHub fetch; production omits it. */
export interface SetupDeps {
  executor?: SqlExecutor;
  fetchImpl?: FetchLike;
}

export async function handleGithubSetupCallback(
  request: Request,
  env: Env,
  requestId: string,
  deps?: SetupDeps,
): Promise<Response> {
  if (!env.PLATFORM_DB) {
    return popupPage("error", "Service unavailable", "The integration service is not ready.");
  }

  const url = new URL(request.url);
  const installationIdRaw = url.searchParams.get("installation_id");
  const state = url.searchParams.get("state");

  const installationId = Number(installationIdRaw);
  if (!installationIdRaw || !Number.isInteger(installationId) || installationId <= 0) {
    return popupPage("error", "Invalid callback", "The installation reference is missing.");
  }

  const executor = deps?.executor ?? createSqlExecutor(env.PLATFORM_DB);
  const owned = !deps?.executor;
  try {
    const repo = createIntegrationsRepository(executor);

    // No usable state → orphan. Covers marketplace installs, tampered or
    // expired state, and replays — identical observable outcome by design.
    const fail = async (): Promise<Response> => {
      await recordOrphan(repo, env, installationId, deps?.fetchImpl);
      return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
    };

    if (!state || !env.INTEGRATIONS_STATE_SECRET) {
      return await fail();
    }

    const payload = await verifyConnectState(state, env.INTEGRATIONS_STATE_SECRET, Date.now());
    if (!payload || payload.p !== "github") {
      return await fail();
    }

    const nonceHash = await hashStateNonce(payload.n);
    const consumed = await repo.consumeConnectionState(nonceHash);
    if (!consumed.ok) {
      return await fail();
    }

    // Defense in depth: the consumed row must be exactly the connection and
    // org the state was minted for.
    const connection = consumed.value;
    if (
      connection.id !== payload.c ||
      connection.orgId !== payload.o ||
      connection.provider !== payload.p
    ) {
      return await fail();
    }

    const configured = getConfiguredProvider(env, "github", deps?.fetchImpl);
    if (!configured) {
      return popupPage(
        "error",
        "Not configured",
        "The GitHub App for this environment is not configured yet.",
      );
    }

    // Verify the installation with GitHub as the App — never trust the
    // redirect's claims beyond the id we look up.
    const facts = await configured.provider.completeConnect({
      installationId,
      nowMs: Date.now(),
    });
    if (!facts || facts.installationId !== installationId) {
      return popupPage(
        "error",
        "Verification failed",
        "GitHub did not confirm this installation. Try connecting again.",
      );
    }

    const installation = await repo.upsertGithubInstallation({
      id: generateUuid(),
      connectionId: asUuid(connection.id),
      installationId,
      accountLogin: facts.accountLogin,
      accountId: facts.accountId,
      accountType: facts.accountType,
      repositorySelection: facts.repositorySelection,
      permissions: facts.permissions,
      events: facts.events,
      suspendedAt: facts.suspendedAt ? new Date(facts.suspendedAt) : null,
    });
    if (!installation.ok) {
      return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
    }
    // The installation row must end up bound to THIS connection — an
    // installation already claimed by another connection must not flip.
    if (installation.value.connectionId !== connection.id) {
      return popupPage(
        "error",
        "Already connected",
        "This GitHub installation is already linked to a connection.",
      );
    }

    const activated = await repo.activateConnection(
      asUuid(connection.orgId),
      asUuid(connection.id),
      {
        displayName: connection.displayName ?? facts.accountLogin,
        externalAccountLogin: facts.accountLogin,
        externalAccountId: facts.accountId == null ? null : String(facts.accountId),
        externalAccountType: facts.accountType,
      },
    );
    if (!activated.ok) {
      if (activated.error.kind === "conflict") {
        return popupPage(
          "error",
          "Already connected",
          "An active connection for this GitHub account already exists in the organization.",
        );
      }
      return popupPage("error", "Connection not completed", LINK_FAILED_MESSAGE);
    }

    try {
      const events = createEventsRepository(executor);
      await events.appendEventWithAudit({
        event: {
          id: generateUuid(),
          type: INTEGRATION_EVENT_TYPES.CONNECTED,
          version: 1,
          source: "integrations-worker",
          occurredAt: new Date(),
          actorType: "user",
          actorId: connection.createdBy ?? "unknown",
          orgId: connection.orgId,
          subjectKind: "integration_connection",
          subjectId: connection.id,
          requestId,
          payload: {
            provider: "github",
            externalAccountLogin: facts.accountLogin,
            repositorySelection: facts.repositorySelection,
          },
        },
        audit: {
          id: generateUuid(),
          category: "integrations",
          description: `GitHub connected${facts.accountLogin ? ` (${facts.accountLogin})` : ""}`,
        },
      });
    } catch {
      // Best-effort: the connection is active; audit emission is not a gate.
    }

    return popupPage(
      "success",
      "GitHub connected",
      `The installation${facts.accountLogin ? ` for ${facts.accountLogin}` : ""} is now linked.`,
    );
  } catch {
    return popupPage("error", "Something went wrong", "Try connecting again from the console.");
  } finally {
    if (owned && "dispose" in executor && typeof (executor as { dispose?: unknown }).dispose === "function") {
      await (executor as unknown as { dispose: () => Promise<void> }).dispose();
    }
  }
}
