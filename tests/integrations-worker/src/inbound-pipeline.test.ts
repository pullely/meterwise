import { handleGithubWebhookIngest } from "@integrations-worker/handlers/ingest";
import { drainInboundDeliveries, processDelivery } from "@integrations-worker/drain";
import { createIntegrationsRepository, type InboundDelivery } from "@saas/db/integrations";
import { createEventsRepository } from "@saas/db/events";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const DELIVERY_UUID = "55555555-5555-4555-8555-555555555555";
const INSTALLATION_ID = 9912345;
const WEBHOOK_SECRET = "whsec-test";
const NOW = new Date("2026-06-11T10:00:00Z");

// ── Fakes ────────────────────────────────────────────────────

type QueryRecord = { text: string; params: unknown[] };
type SqlResponder = (text: string, params: unknown[]) => Record<string, unknown>[] | null;

function fakeExecutor(respond: SqlResponder): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      const rows = (respond(text, params ?? []) ?? []) as unknown as T[];
      return { rows, rowCount: rows.length };
    },
  };
  return { executor, queries };
}

function createEnv(overrides?: Partial<Record<string, unknown>>): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    GITHUB_APP_ID: "4242",
    GITHUB_APP_SLUG: "sourceplane-test",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nirrelevant\n-----END PRIVATE KEY-----",
    GITHUB_APP_WEBHOOK_SECRET: WEBHOOK_SECRET,
    INTEGRATIONS_STATE_SECRET: "state-secret",
    ...overrides,
  } as unknown as Env;
}

async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return `sha256=${hex}`;
}

function ingestRequest(
  body: string,
  headers: Record<string, string>,
): Request {
  return new Request("https://worker.test/ingress/github/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function deliveryRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: DELIVERY_UUID,
    org_id: null,
    connection_id: null,
    provider: "github",
    delivery_key: "gh-uuid-1",
    event_type: "push",
    action: null,
    payload: {
      ref: "refs/heads/main",
      before: "aaa",
      after: "bbb",
      repository: { id: 777001, full_name: "acme/storefront" },
      installation: { id: INSTALLATION_ID },
      commits: [],
      pusher: { name: "octocat" },
    },
    signature_ok: true,
    status: "received",
    attempts: 0,
    next_attempt_at: null,
    failure_reason: null,
    emitted_event_id: null,
    received_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function installationRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    connection_id: CONNECTION_UUID,
    installation_id: String(INSTALLATION_ID),
    account_login: "acme",
    account_id: "42",
    account_type: "Organization",
    repository_selection: "selected",
    permissions: {},
    events: ["push"],
    suspended_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function connectionRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CONNECTION_UUID,
    org_id: ORG_UUID,
    provider: "github",
    status: "active",
    display_name: "acme",
    external_account_login: "acme",
    external_account_id: "42",
    external_account_type: "Organization",
    created_by: null,
    state_expires_at: null,
    connected_at: NOW.toISOString(),
    suspended_at: null,
    revoked_at: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

const EVENT_ROW = {
  _event: {
    id: "evt", type: "scm.push", version: 1, source: "integrations-worker",
    occurred_at: NOW.toISOString(), actor_type: "system", actor_id: "integrations-worker",
    org_id: ORG_UUID, subject_kind: "repository", subject_id: "777001",
    request_id: "igd_x", payload: "{}",
  },
  _audit: {
    id: "aud", event_id: "evt", org_id: ORG_UUID, actor_type: "system",
    actor_id: "integrations-worker", event_type: "scm.push", event_version: 1,
    source: "integrations-worker", subject_kind: "repository", subject_id: "777001",
    category: "integrations", description: "x", occurred_at: NOW.toISOString(),
    request_id: "igd_x", payload: "{}",
  },
};

function drainCtx(respond: SqlResponder) {
  const { executor, queries } = fakeExecutor(respond);
  return {
    ctx: {
      executor,
      repo: createIntegrationsRepository(executor),
      events: createEventsRepository(executor),
      now: () => NOW,
    },
    queries,
  };
}

// ── Ingest ──────────────────────────────────────────────────

describe("POST /ingress/github/webhook — verify, insert, ack", () => {
  const BODY = JSON.stringify({ action: "opened", installation: { id: INSTALLATION_ID } });

  it("accepts a correctly signed delivery and persists the inbox row", async () => {
    const { executor, queries } = fakeExecutor((text, params) => {
      if (text.includes("INSERT INTO integrations_inbound_deliveries")) {
        return [deliveryRow({ delivery_key: params[2] as string })];
      }
      return [];
    });
    const res = await handleGithubWebhookIngest(
      ingestRequest(BODY, {
        "x-github-delivery": "gh-uuid-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": await signBody(WEBHOOK_SECRET, BODY),
      }),
      createEnv(),
      "req_1",
      { executor },
    );
    expect(res.status).toBe(202);
    const insert = queries.find((q) => q.text.includes("INSERT INTO integrations_inbound_deliveries"));
    expect(insert).toBeDefined();
    expect(insert!.text).toContain("ON CONFLICT (provider, delivery_key) DO NOTHING");
    expect(insert!.params[2]).toBe("gh-uuid-1");
    expect(insert!.params[3]).toBe("pull_request");
    expect(insert!.params[4]).toBe("opened");
  });

  it("acks a redelivery as a no-op (idempotency ledger)", async () => {
    let call = 0;
    const { executor } = fakeExecutor((text) => {
      if (text.includes("INSERT INTO integrations_inbound_deliveries")) {
        call++;
        return []; // conflict → no row
      }
      if (text.includes("WHERE provider = $1 AND delivery_key = $2")) return [deliveryRow()];
      return [];
    });
    const res = await handleGithubWebhookIngest(
      ingestRequest(BODY, {
        "x-github-delivery": "gh-uuid-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": await signBody(WEBHOOK_SECRET, BODY),
      }),
      createEnv(),
      "req_1",
      { executor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { duplicate: boolean } };
    expect(body.data.duplicate).toBe(true);
    expect(call).toBe(1);
  });

  it("rejects a bad signature with an immediate 401 and zero DB work", async () => {
    const { executor, queries } = fakeExecutor(() => []);
    const res = await handleGithubWebhookIngest(
      ingestRequest(BODY, {
        "x-github-delivery": "gh-uuid-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": await signBody("wrong-secret", BODY),
      }),
      createEnv(),
      "req_1",
      { executor },
    );
    expect(res.status).toBe(401);
    expect(queries).toHaveLength(0);
  });

  it("requires delivery + event headers and caps the body size", async () => {
    const { executor } = fakeExecutor(() => []);
    const env = createEnv();
    const sig = await signBody(WEBHOOK_SECRET, BODY);

    const noDelivery = await handleGithubWebhookIngest(
      ingestRequest(BODY, { "x-github-event": "push", "x-hub-signature-256": sig }),
      env, "req_1", { executor },
    );
    expect(noDelivery.status).toBe(400);

    const noEvent = await handleGithubWebhookIngest(
      ingestRequest(BODY, { "x-github-delivery": "gh-1", "x-hub-signature-256": sig }),
      env, "req_1", { executor },
    );
    expect(noEvent.status).toBe(400);

    const huge = new Request("https://worker.test/ingress/github/webhook", {
      method: "POST",
      headers: {
        "x-github-delivery": "gh-1",
        "x-github-event": "push",
        "content-length": String(6 * 1024 * 1024),
      },
    });
    const tooBig = await handleGithubWebhookIngest(huge, env, "req_1", { executor });
    expect(tooBig.status).toBe(413);
  });

  it("503s when the webhook secret is not configured (D1 parked)", async () => {
    const { executor } = fakeExecutor(() => []);
    const res = await handleGithubWebhookIngest(
      ingestRequest(BODY, { "x-github-delivery": "gh-1", "x-github-event": "push" }),
      createEnv({ GITHUB_APP_WEBHOOK_SECRET: undefined }),
      "req_1",
      { executor },
    );
    expect(res.status).toBe(503);
  });
});

// ── Drain ───────────────────────────────────────────────────

describe("inbox drain — attribute, lifecycle, normalize, emit", () => {
  it("emits scm.push transactionally-with-mark for an attributed delivery", async () => {
    const { ctx, queries } = drainCtx((text) => {
      if (text.includes("FROM integrations_github_installations WHERE installation_id"))
        return [installationRow()];
      if (text.includes("FROM integrations_connections WHERE id = $1")) return [connectionRow()];
      if (text.includes("events_event_log")) return [EVENT_ROW];
      if (text.includes("UPDATE integrations_inbound_deliveries"))
        return [deliveryRow({ status: "emitted" })];
      return [];
    });

    const outcome = await processDelivery(ctx, mapDelivery(deliveryRow()));
    expect(outcome).toEqual({ kind: "emitted", eventType: "scm.push" });

    const mark = queries.find((q) => q.text.includes("UPDATE integrations_inbound_deliveries"));
    expect(mark).toBeDefined();
    expect(mark!.params).toContain("emitted");
    const eventInsert = queries.find((q) => q.text.includes("events_event_log"));
    expect(eventInsert!.params[1]).toBe("scm.push");
    expect(eventInsert!.params[9]).toBe(ORG_UUID); // org attribution from the connection
  });

  it("emits per-project events with the environment resolved from the branch map (IG3)", async () => {
    const PROJECT_UUID = "44444444-4444-4444-8444-444444444444";
    const { ctx, queries } = drainCtx((text) => {
      if (text.includes("FROM integrations_github_installations WHERE installation_id"))
        return [installationRow()];
      if (text.includes("FROM integrations_connections WHERE id = $1")) return [connectionRow()];
      if (text.includes("FROM integrations_repo_links"))
        return [
          {
            id: "ln1",
            org_id: ORG_UUID,
            project_id: PROJECT_UUID,
            connection_id: CONNECTION_UUID,
            repo_external_id: "777001",
            repo_full_name: "acme/storefront",
            default_branch: "main",
            branch_env_map: { main: "prod" },
            status: "active",
            created_by: null,
            created_at: NOW.toISOString(),
            updated_at: NOW.toISOString(),
          },
        ];
      if (text.includes("events_event_log")) return [EVENT_ROW];
      if (text.includes("UPDATE integrations_inbound_deliveries"))
        return [deliveryRow({ status: "emitted" })];
      return [];
    });

    const outcome = await processDelivery(ctx, mapDelivery(deliveryRow()));
    expect(outcome).toEqual({ kind: "emitted", eventType: "scm.push" });

    const eventInsert = queries.find((q) => q.text.includes("events_event_log"));
    expect(eventInsert!.params[10]).toBe(PROJECT_UUID); // event row project_id
    const payload = JSON.parse(eventInsert!.params[19] as string) as Record<string, unknown>;
    expect(payload.projectId).toBe(`prj_${PROJECT_UUID.replace(/-/g, "")}`);
    expect(payload.environment).toBe("prod"); // branch "main" resolved via map
  });

  it("skips unattributed installations and records them as orphaned", async () => {
    const { ctx, queries } = drainCtx((text) => {
      if (text.includes("FROM integrations_github_installations WHERE installation_id")) return [];
      if (text.includes("INSERT INTO integrations_github_installations"))
        return [installationRow({ connection_id: null })];
      if (text.includes("UPDATE integrations_inbound_deliveries"))
        return [deliveryRow({ status: "skipped" })];
      return [];
    });
    const outcome = await processDelivery(ctx, mapDelivery(deliveryRow()));
    expect(outcome).toEqual({ kind: "skipped", reason: "unattributed_installation" });
    const orphan = queries.find((q) =>
      q.text.includes("INSERT INTO integrations_github_installations"),
    );
    expect(orphan!.params[1]).toBeNull();
    expect(queries.some((q) => q.text.includes("events_event_log"))).toBe(false);
  });

  it("processes provider uninstall: connection revoked + integration.revoked", async () => {
    const { ctx, queries } = drainCtx((text) => {
      if (text.includes("FROM integrations_github_installations WHERE installation_id"))
        return [installationRow()];
      if (text.includes("FROM integrations_connections WHERE id = $1")) return [connectionRow()];
      if (text.includes("SET status = $3"))
        return [connectionRow({ status: "revoked", revoked_at: NOW.toISOString() })];
      if (text.includes("events_event_log"))
        return [{ ...EVENT_ROW, _event: { ...EVENT_ROW._event, type: "integration.revoked" } }];
      if (text.includes("UPDATE integrations_inbound_deliveries"))
        return [deliveryRow({ status: "emitted" })];
      return [];
    });

    const outcome = await processDelivery(
      ctx,
      mapDelivery(
        deliveryRow({
          event_type: "installation",
          action: "deleted",
          payload: { action: "deleted", installation: { id: INSTALLATION_ID } },
        }),
      ),
    );
    expect(outcome).toEqual({ kind: "emitted", eventType: "integration.revoked" });
    expect(queries.some((q) => q.text.includes("SET status = $3") && q.params[2] === "revoked")).toBe(true);
    expect(queries.some((q) => q.text.includes("DELETE FROM integrations_installation_tokens"))).toBe(true);
  });

  it("suspend/unsuspend flip the connection and emit lifecycle events", async () => {
    for (const [action, status, eventType] of [
      ["suspend", "suspended", "integration.suspended"],
      ["unsuspend", "active", "integration.reactivated"],
    ] as const) {
      const { ctx, queries } = drainCtx((text) => {
        if (text.includes("FROM integrations_github_installations WHERE installation_id"))
          return [installationRow()];
        if (text.includes("FROM integrations_connections WHERE id = $1")) return [connectionRow()];
        if (text.includes("SET status = $3")) return [connectionRow({ status })];
        if (text.includes("events_event_log")) return [EVENT_ROW];
        if (text.includes("UPDATE integrations_inbound_deliveries"))
          return [deliveryRow({ status: "emitted" })];
        return [];
      });
      const outcome = await processDelivery(
        ctx,
        mapDelivery(
          deliveryRow({
            event_type: "installation",
            action,
            payload: { action, installation: { id: INSTALLATION_ID } },
          }),
        ),
      );
      expect(outcome).toEqual({ kind: "emitted", eventType });
      expect(queries.some((q) => q.params[2] === status)).toBe(true);
    }
  });

  it("skips deliveries for revoked connections and unsupported events", async () => {
    const revoked = drainCtx((text) => {
      if (text.includes("FROM integrations_github_installations WHERE installation_id"))
        return [installationRow()];
      if (text.includes("FROM integrations_connections WHERE id = $1"))
        return [connectionRow({ status: "revoked" })];
      if (text.includes("UPDATE integrations_inbound_deliveries"))
        return [deliveryRow({ status: "skipped" })];
      return [];
    });
    expect(await processDelivery(revoked.ctx, mapDelivery(deliveryRow()))).toEqual({
      kind: "skipped",
      reason: "connection_revoked",
    });

    const unsupported = drainCtx((text) => {
      if (text.includes("FROM integrations_github_installations WHERE installation_id"))
        return [installationRow()];
      if (text.includes("FROM integrations_connections WHERE id = $1")) return [connectionRow()];
      if (text.includes("UPDATE integrations_inbound_deliveries"))
        return [deliveryRow({ status: "skipped" })];
      return [];
    });
    expect(
      await processDelivery(
        unsupported.ctx,
        mapDelivery(
          deliveryRow({
            event_type: "watch",
            payload: {
              repository: { id: 777001, full_name: "acme/storefront" },
              installation: { id: INSTALLATION_ID },
            },
          }),
        ),
      ),
    ).toEqual({ kind: "skipped", reason: "unsupported_event" });
  });

  it("retries with backoff on emit failure and goes terminal after 5 attempts", async () => {
    const failing = (attempts: number) =>
      drainCtx((text) => {
        if (text.includes("FROM integrations_github_installations WHERE installation_id"))
          return [installationRow()];
        if (text.includes("FROM integrations_connections WHERE id = $1")) return [connectionRow()];
        if (text.includes("events_event_log")) return []; // append fails (conflict shape)
        if (text.includes("UPDATE integrations_inbound_deliveries"))
          return [deliveryRow({ attempts })];
        return [];
      });

    const first = failing(0);
    const retried = await processDelivery(first.ctx, mapDelivery(deliveryRow({ attempts: 0 })));
    expect(retried).toEqual({ kind: "retried", attempts: 1 });
    const retryMark = first.queries.find((q) =>
      q.text.includes("UPDATE integrations_inbound_deliveries"),
    );
    expect(retryMark!.params).toContain(1); // attempts bumped
    expect(retryMark!.params[5]).toBeTruthy(); // next_attempt_at scheduled

    const last = failing(4);
    const failed = await processDelivery(last.ctx, mapDelivery(deliveryRow({ attempts: 4 })));
    expect(failed).toEqual({ kind: "failed", reason: "emit_failed" });
    const failMark = last.queries.find((q) =>
      q.text.includes("UPDATE integrations_inbound_deliveries"),
    );
    expect(failMark!.params).toContain("failed");
  });

  it("drains a batch oldest-first and reports a summary", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("status IN ('received', 'attributed')"))
        return [deliveryRow(), deliveryRow({ id: "77777777-7777-4777-8777-777777777777", event_type: "watch" })];
      if (text.includes("FROM integrations_github_installations WHERE installation_id"))
        return [installationRow()];
      if (text.includes("FROM integrations_connections WHERE id = $1")) return [connectionRow()];
      if (text.includes("events_event_log")) return [EVENT_ROW];
      if (text.includes("UPDATE integrations_inbound_deliveries")) return [deliveryRow()];
      return [];
    });
    const summary = await drainInboundDeliveries(executor, createEnv(), { now: () => NOW });
    expect(summary.processed).toBe(2);
    expect(summary.emitted).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
  });
});

// Map a raw row through the repo mapper shape used by the drain.
function mapDelivery(row: Record<string, unknown>): InboundDelivery {
  return {
    id: row.id as string,
    orgId: (row.org_id as string) ?? null,
    connectionId: (row.connection_id as string) ?? null,
    provider: row.provider as string,
    deliveryKey: row.delivery_key as string,
    eventType: row.event_type as string,
    action: (row.action as string) ?? null,
    payload: row.payload as Record<string, unknown>,
    signatureOk: row.signature_ok as boolean,
    status: row.status as InboundDelivery["status"],
    attempts: Number(row.attempts),
    nextAttemptAt: null,
    failureReason: (row.failure_reason as string) ?? null,
    emittedEventId: (row.emitted_event_id as string) ?? null,
    receivedAt: new Date(row.received_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}
