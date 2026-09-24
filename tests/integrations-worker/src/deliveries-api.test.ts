import { handleListDeliveries, handleReplayDelivery } from "@integrations-worker/handlers/deliveries";
import type { Env } from "@integrations-worker/env";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";
import { asUuid } from "@saas/db";

const ORG_UUID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_UUID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_UUID = "33333333-3333-4333-8333-333333333333";
const DELIVERY_UUID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-06-11T10:00:00Z");
const ACTOR = { subjectId: "usr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subjectType: "user" };

type QueryRecord = { text: string; params: unknown[] };

function fakeExecutor(
  respond: (text: string, params: unknown[]) => Record<string, unknown>[] | null,
): { executor: SqlExecutor; queries: QueryRecord[] } {
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

function jsonFetcher(body: unknown): Fetcher {
  return {
    fetch: () => Promise.resolve(Response.json(body)),
    connect() {
      throw new Error("not implemented");
    },
  } as unknown as Fetcher;
}

function createEnv(): Env {
  return {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://fake" },
    MEMBERSHIP_WORKER: jsonFetcher({
      data: {
        memberships: [
          { kind: "role_assignment", role: "admin", scope: { kind: "organization", orgId: ORG_UUID } },
        ],
      },
    }),
    POLICY_WORKER: jsonFetcher({ data: { allow: true, reason: "org_admin" } }),
  } as unknown as Env;
}

function connectionRow(): Record<string, unknown> {
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
  };
}

function deliveryRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: DELIVERY_UUID,
    org_id: ORG_UUID,
    connection_id: CONNECTION_UUID,
    provider: "github",
    delivery_key: "gh-uuid-1",
    event_type: "push",
    action: null,
    payload: { repository: { id: 1, full_name: "a/b" }, installation: { id: 1 } },
    signature_ok: true,
    status: "emitted",
    attempts: 1,
    next_attempt_at: null,
    failure_reason: null,
    emitted_event_id: "evt-uuid",
    received_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

describe("GET .../integrations/{id}/deliveries", () => {
  it("lists the connection-scoped delivery log as a safe projection", async () => {
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_connections WHERE org_id")) return [connectionRow()];
      if (text.includes("FROM integrations_inbound_deliveries")) return [deliveryRow()];
      return [];
    });
    const res = await handleListDeliveries(
      new Request("https://worker.test/x"),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      asUuid(CONNECTION_UUID),
      { executor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { deliveries: Array<Record<string, unknown>> };
    };
    const delivery = body.data.deliveries[0]!;
    expect(delivery.id).toMatch(/^igd_[0-9a-f]{32}$/);
    expect(delivery.eventType).toBe("push");
    // Raw payload and delivery key never cross the public surface.
    expect(delivery.payload).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("gh-uuid-1");

    const list = queries.find((q) => q.text.includes("FROM integrations_inbound_deliveries"));
    expect(list!.text).toContain("AND connection_id = $2");
  });

  it("404s when the connection belongs to another org", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_connections WHERE org_id")) return [];
      return [];
    });
    const res = await handleListDeliveries(
      new Request("https://worker.test/x"),
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(OTHER_ORG_UUID),
      asUuid(CONNECTION_UUID),
      { executor },
    );
    expect(res.status).toBe(404);
  });
});

describe("POST .../deliveries/{id}/replay", () => {
  it("404s for a delivery attributed to a different org", async () => {
    const { executor } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_connections WHERE org_id")) return [connectionRow()];
      if (text.includes("FROM integrations_inbound_deliveries WHERE id"))
        return [deliveryRow({ org_id: OTHER_ORG_UUID })];
      return [];
    });
    const res = await handleReplayDelivery(
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      asUuid(CONNECTION_UUID),
      asUuid(DELIVERY_UUID),
      { executor },
    );
    expect(res.status).toBe(404);
  });

  it("re-runs normalize/emit from the persisted row and returns the updated delivery", async () => {
    const EVENT_ROW = {
      _event: { id: "evt2", type: "scm.push", occurred_at: NOW.toISOString(), payload: "{}" },
      _audit: { id: "aud2", occurred_at: NOW.toISOString(), payload: "{}" },
    };
    const installationRow = {
      id: "66666666-6666-4666-8666-666666666666",
      connection_id: CONNECTION_UUID,
      installation_id: "1",
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    let reads = 0;
    const { executor, queries } = fakeExecutor((text) => {
      if (text.includes("FROM integrations_connections WHERE org_id")) return [connectionRow()];
      if (text.includes("FROM integrations_inbound_deliveries WHERE id")) {
        reads++;
        return [
          reads === 1
            ? deliveryRow({
                status: "failed",
                payload: {
                  ref: "refs/heads/main",
                  before: "a",
                  after: "b",
                  commits: [],
                  repository: { id: 1, full_name: "acme/storefront" },
                  installation: { id: 1 },
                },
              })
            : deliveryRow({ status: "emitted" }),
        ];
      }
      if (text.includes("FROM integrations_github_installations WHERE installation_id"))
        return [installationRow];
      if (text.includes("FROM integrations_connections WHERE id = $1")) return [connectionRow()];
      if (text.includes("events_event_log")) return [EVENT_ROW];
      if (text.includes("UPDATE integrations_inbound_deliveries"))
        return [deliveryRow({ status: "emitted" })];
      return [];
    });

    const res = await handleReplayDelivery(
      createEnv(),
      "req_1",
      ACTOR,
      asUuid(ORG_UUID),
      asUuid(CONNECTION_UUID),
      asUuid(DELIVERY_UUID),
      { executor },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { delivery: { status: string } } };
    expect(body.data.delivery.status).toBe("emitted");
    // Replay emitted a fresh event from the PERSISTED payload.
    expect(queries.some((q) => q.text.includes("events_event_log"))).toBe(true);
  });
});
