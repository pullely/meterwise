import crypto from "node:crypto";
import {
  enqueueNotification,
  validateEnqueueRequest,
  toDeliveryStatus,
  getNotificationByPublicId,
} from "@notifications-worker/services/notifications";
import { createLocalDebugProvider } from "@notifications-worker/providers/local-debug";
import { notificationPublicId } from "@notifications-worker/ids";
import type { Env } from "@notifications-worker/env";
import type {
  NotificationsRepository,
  StoredNotification,
  StoredNotificationAttempt,
  StoredNotificationPreference,
  StoredNotificationSuppression,
  CreateNotificationInput,
  CreateNotificationAttemptInput,
  CreateNotificationSuppressionInput,
  MarkNotificationStatusInput,
  UpsertNotificationPreferenceInput,
} from "@saas/db/notifications";
import type { NotificationProvider, ProviderSendContext, ProviderSendResult } from "@saas/contracts/notifications";
import { asUuid } from "@saas/db";

if (!(globalThis as Record<string, unknown>).crypto) {
  (globalThis as Record<string, unknown>).crypto = crypto;
}

interface FakeStore {
  notifications: Map<string, StoredNotification>;
  attempts: StoredNotificationAttempt[];
  preferences: Map<string, StoredNotificationPreference>;
  suppressions: Map<string, StoredNotificationSuppression>;
  idempotency: Map<string, string>;
}

function createFakeRepo(): NotificationsRepository & { _store: FakeStore } {
  const store: FakeStore = {
    notifications: new Map(),
    attempts: [],
    preferences: new Map(),
    suppressions: new Map(),
    idempotency: new Map(),
  };

  const repo: NotificationsRepository & { _store: FakeStore } = {
    _store: store,
    async createNotification(input: CreateNotificationInput) {
      if (store.notifications.has(input.id)) {
        return { ok: false, error: { kind: "conflict", entity: "notification" } };
      }
      if (input.idempotencyKey) {
        const k = `${input.orgId}|${input.idempotencyKey}`;
        if (store.idempotency.has(k)) {
          return { ok: false, error: { kind: "conflict", entity: "notification" } };
        }
        store.idempotency.set(k, input.id);
      }
      const row: StoredNotification = {
        id: input.id,
        orgId: input.orgId,
        category: input.category,
        templateKey: input.templateKey,
        templateData: input.templateData,
        channel: input.channel,
        recipientAddress: input.recipientAddress.toLowerCase(),
        recipientSubjectKind: input.recipientSubjectKind ?? null,
        recipientSubjectId: input.recipientSubjectId ?? null,
        status: input.status,
        providerMessageId: null,
        lastError: null,
        idempotencyKey: input.idempotencyKey ?? null,
        correlationId: input.correlationId ?? null,
        queuedAt: input.queuedAt,
        sentAt: null,
        failedAt: null,
        updatedAt: input.queuedAt,
      };
      store.notifications.set(row.id, row);
      return { ok: true, value: row };
    },
    async getNotificationById(id: string) {
      const row = store.notifications.get(id);
      if (!row) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: row };
    },
    async findNotificationByIdempotencyKey(orgId: string, key: string) {
      const id = store.idempotency.get(`${orgId}|${key}`);
      if (!id) return { ok: false, error: { kind: "not_found" } };
      const row = store.notifications.get(id);
      if (!row) return { ok: false, error: { kind: "not_found" } };
      return { ok: true, value: row };
    },
    async markNotificationStatus(input: MarkNotificationStatusInput) {
      const row = store.notifications.get(input.id);
      if (!row || row.orgId !== input.orgId) return { ok: false, error: { kind: "not_found" } };
      const updated: StoredNotification = {
        ...row,
        status: input.status,
        providerMessageId: input.providerMessageId ?? row.providerMessageId,
        lastError: input.lastError ?? null,
        sentAt: input.sentAt ?? row.sentAt,
        failedAt: input.failedAt ?? row.failedAt,
        updatedAt: input.updatedAt,
      };
      store.notifications.set(row.id, updated);
      return { ok: true, value: updated };
    },
    async recordAttempt(input: CreateNotificationAttemptInput) {
      const row: StoredNotificationAttempt = {
        id: input.id,
        notificationId: input.notificationId,
        orgId: input.orgId,
        attemptNumber: input.attemptNumber,
        status: input.status,
        providerMessageId: input.providerMessageId ?? null,
        errorReason: input.errorReason ?? null,
        attemptedAt: input.attemptedAt,
      };
      store.attempts.push(row);
      return { ok: true, value: row };
    },
    async listAttempts(notificationId: string) {
      return { ok: true, value: store.attempts.filter((a) => a.notificationId === notificationId) };
    },
    async listPreferences(orgId, subjectKind, subjectId, channel) {
      const list: StoredNotificationPreference[] = [];
      for (const p of store.preferences.values()) {
        if (p.orgId === orgId && p.subjectKind === subjectKind && p.subjectId === subjectId) {
          if (!channel || p.channel === channel) list.push(p);
        }
      }
      return { ok: true, value: list };
    },
    async upsertPreference(input: UpsertNotificationPreferenceInput) {
      const k = `${input.orgId}|${input.subjectKind}|${input.subjectId}|${input.channel}`;
      const existing = store.preferences.get(k);
      const row: StoredNotificationPreference = {
        id: existing?.id ?? input.id,
        orgId: input.orgId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        channel: input.channel,
        categories: input.categories,
        createdAt: existing?.createdAt ?? input.updatedAt,
        updatedAt: input.updatedAt,
      };
      store.preferences.set(k, row);
      return { ok: true, value: row };
    },
    async isSuppressed(orgId: string, channel: string, address: string) {
      const k = `${orgId}|${channel}|${address.toLowerCase()}`;
      return { ok: true, value: store.suppressions.has(k) };
    },
    async createSuppression(input: CreateNotificationSuppressionInput) {
      const row: StoredNotificationSuppression = {
        id: input.id,
        orgId: input.orgId,
        channel: input.channel,
        address: input.address.toLowerCase(),
        reason: input.reason,
        createdAt: input.createdAt,
      };
      store.suppressions.set(`${row.orgId}|${row.channel}|${row.address}`, row);
      return { ok: true, value: row };
    },
  };
  return repo;
}

function createCapturingEmitter() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    emit: async (_env: Env, input: { type: string; payload: Record<string, unknown> }) => {
      events.push({ type: input.type, payload: input.payload });
    },
  };
}

function createFailingProvider(reason = "smtp_unreachable"): NotificationProvider {
  return {
    name: "failing-test",
    async send(ctx: ProviderSendContext): Promise<ProviderSendResult> {
      return { ok: false, providerMessageId: null, errorReason: reason + ":" + ctx.notificationId.slice(0, 4) };
    },
  };
}

const fixedNow = new Date("2026-03-01T12:00:00.000Z");
const fakeEnv: Env = { ENVIRONMENT: "test", NOTIFICATIONS_PROVIDER: "local-debug" };
const ORG_UUID = asUuid("11111111-1111-1111-1111-111111111111");
const baseRequest = {
  orgId: ORG_UUID,
  category: "invitation" as const,
  templateKey: "invitation.created",
  templateData: { inviteeName: "Ada" },
  recipient: { channel: "email" as const, address: "Ada@Example.com" },
};

describe("validateEnqueueRequest", () => {
  it("accepts a minimal valid payload", () => {
    const r = validateEnqueueRequest(baseRequest);
    expect(r.ok).toBe(true);
  });

  it("rejects non-email channel", () => {
    const r = validateEnqueueRequest({ ...baseRequest, recipient: { channel: "sms", address: "x@y.com" } });
    expect(r.ok).toBe(false);
    expect(r.errors["recipient.channel"]).toBeDefined();
  });

  it("rejects unknown category", () => {
    const r = validateEnqueueRequest({ ...baseRequest, category: "marketing" });
    expect(r.ok).toBe(false);
    expect(r.errors.category).toBeDefined();
  });

  it("rejects malformed email", () => {
    const r = validateEnqueueRequest({ ...baseRequest, recipient: { channel: "email", address: "not-an-email" } });
    expect(r.ok).toBe(false);
    expect(r.errors["recipient.address"]).toBeDefined();
  });

  it("rejects templateData containing non-scalar values", () => {
    const r = validateEnqueueRequest({ ...baseRequest, templateData: { obj: { nested: "x" } } });
    expect(r.ok).toBe(false);
    expect(r.errors["templateData.obj"]).toBeDefined();
  });
});

describe("enqueueNotification — happy path", () => {
  it("creates a notification, records attempt, marks sent, emits queued+sent", async () => {
    const repo = createFakeRepo();
    const provider = createLocalDebugProvider();
    const cap = createCapturingEmitter();
    const id = "22222222-2222-4222-8222-222222222222";

    const result = await enqueueNotification(
      {
        repo,
        provider,
        env: fakeEnv,
        actorType: "service",
        actorId: "membership-worker",
        requestId: "req_test_1",
        now: () => fixedNow,
        generateUuid: () => id,
        emit: cap.emit,
      },
      baseRequest,
    );

    expect("outcome" in result).toBe(true);
    if ("outcome" in result) {
      expect(result.outcome.response.notification.status).toBe("sent");
      expect(result.outcome.response.notification.providerMessageId).toContain("local-debug-");
      expect(result.outcome.response.notification.attempts).toHaveLength(1);
      expect(result.outcome.response.notification.id.startsWith("ntf_")).toBe(true);
    }

    const stored = [...repo._store.notifications.values()][0]!;
    expect(stored.recipientAddress).toBe("ada@example.com");

    expect(cap.events.map((e) => e.type)).toEqual([
      "notification.queued",
      "notification.sent",
    ]);

    for (const ev of cap.events) {
      expect(ev.payload).not.toHaveProperty("templateData");
      expect(JSON.stringify(ev.payload)).not.toContain("Ada");
    }
  });
});

describe("enqueueNotification — suppression", () => {
  it("short-circuits when recipient is suppressed and emits suppressed event", async () => {
    const repo = createFakeRepo();
    const provider = createLocalDebugProvider();
    const cap = createCapturingEmitter();

    await repo.createSuppression({
      id: "33333333-3333-4333-8333-333333333333",
      orgId: baseRequest.orgId,
      channel: "email",
      address: "ada@example.com",
      reason: "bounce",
      createdAt: fixedNow,
    });

    let sendCalls = 0;
    const realSend = provider.send.bind(provider);
    provider.send = async (ctx) => {
      sendCalls++;
      return realSend(ctx);
    };

    const result = await enqueueNotification(
      {
        repo,
        provider,
        env: fakeEnv,
        actorType: "service",
        actorId: "membership-worker",
        requestId: "req_test_supp",
        now: () => fixedNow,
        generateUuid: () => "44444444-4444-4444-8444-444444444444",
        emit: cap.emit,
      },
      baseRequest,
    );

    expect(sendCalls).toBe(0);
    if ("outcome" in result) {
      expect(result.outcome.status).toBe("suppressed");
      expect(result.outcome.response.notification.status).toBe("suppressed");
    }
    expect(cap.events.map((e) => e.type)).toEqual(["notification.suppressed"]);
  });
});

describe("enqueueNotification — provider failure", () => {
  it("marks notification failed and emits notification.failed", async () => {
    const repo = createFakeRepo();
    const provider = createFailingProvider();
    const cap = createCapturingEmitter();

    const result = await enqueueNotification(
      {
        repo,
        provider,
        env: fakeEnv,
        actorType: "service",
        actorId: "billing-worker",
        requestId: "req_test_fail",
        now: () => fixedNow,
        generateUuid: () => "55555555-5555-4555-8555-555555555555",
        emit: cap.emit,
      },
      baseRequest,
    );

    if ("outcome" in result) {
      expect(result.outcome.response.notification.status).toBe("failed");
      expect(result.outcome.response.notification.lastError).toContain("smtp_unreachable");
    }
    expect(cap.events.map((e) => e.type)).toEqual([
      "notification.queued",
      "notification.failed",
    ]);
  });
});

describe("enqueueNotification — idempotency", () => {
  it("returns the existing notification on idempotency hit and does not double-send", async () => {
    const repo = createFakeRepo();
    const provider = createLocalDebugProvider();
    const cap = createCapturingEmitter();

    let sendCalls = 0;
    const realSend = provider.send.bind(provider);
    provider.send = async (ctx) => {
      sendCalls++;
      return realSend(ctx);
    };

    let ids = 0;
    const genUuid = () => {
      ids++;
      const x = ids.toString(16).padStart(2, "0");
      return `66666666-6666-4666-8666-6666666666${x}`;
    };

    const baseDeps = {
      repo,
      provider,
      env: fakeEnv,
      actorType: "service",
      actorId: "membership-worker",
      requestId: "req_test_idem",
      now: () => fixedNow,
      emit: cap.emit,
      generateUuid: genUuid,
    };

    const first = await enqueueNotification(
      baseDeps,
      { ...baseRequest, idempotencyKey: "idem-1" },
    );
    const second = await enqueueNotification(
      baseDeps,
      { ...baseRequest, idempotencyKey: "idem-1" },
    );

    if ("outcome" in first && "outcome" in second) {
      expect(second.outcome.status).toBe("idempotent_hit");
      expect(second.outcome.response.notification.id).toBe(first.outcome.response.notification.id);
    }
    expect(sendCalls).toBe(1);
  });
});

describe("getNotificationByPublicId", () => {
  it("returns 404 for malformed public id", async () => {
    const repo = createFakeRepo();
    const r = await getNotificationByPublicId(repo, "not-an-id");
    expect("error" in r && r.error.status).toBe(404);
  });

  it("returns the notification for an existing public id", async () => {
    const repo = createFakeRepo();
    const id = "77777777-7777-4777-8777-777777777777";
    await repo.createNotification({
      id,
      orgId: baseRequest.orgId,
      category: "invitation",
      templateKey: "invitation.created",
      templateData: {},
      channel: "email",
      recipientAddress: "ada@example.com",
      status: "sent",
      queuedAt: fixedNow,
    });
    const r = await getNotificationByPublicId(repo, notificationPublicId(id));
    expect("response" in r).toBe(true);
    if ("response" in r) {
      expect(r.response.notification.id).toBe(notificationPublicId(id));
    }
  });
});

describe("local-debug provider", () => {
  it("returns ok and a synthetic provider message id", async () => {
    const p = createLocalDebugProvider();
    const r = await p.send({
      notificationId: "88888888-8888-4888-8888-888888888888",
      orgId: baseRequest.orgId,
      category: "invitation",
      templateKey: "invitation.created",
      templateData: {},
      recipient: { channel: "email", address: "test@example.com" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.providerMessageId).toContain("local-debug-");
    }
  });
});

describe("toDeliveryStatus", () => {
  it("emits ntf_-prefixed id and ISO timestamps", () => {
    const row: StoredNotification = {
      id: "99999999-9999-4999-8999-999999999999",
      orgId: baseRequest.orgId,
      category: "billing",
      templateKey: "billing.receipt",
      templateData: {},
      channel: "email",
      recipientAddress: "x@y.com",
      recipientSubjectKind: null,
      recipientSubjectId: null,
      status: "sent",
      providerMessageId: "p-abc",
      lastError: null,
      idempotencyKey: null,
      correlationId: null,
      queuedAt: fixedNow,
      sentAt: fixedNow,
      failedAt: null,
      updatedAt: fixedNow,
    };
    const status = toDeliveryStatus(row, []);
    expect(status.id.startsWith("ntf_")).toBe(true);
    expect(status.queuedAt).toBe(fixedNow.toISOString());
    expect(status.sentAt).toBe(fixedNow.toISOString());
    expect(status.failedAt).toBeNull();
  });
});
