import {
  createConfigRepository,
} from "@saas/db/config";
import { asUuid } from "@saas/db";
import type {
  Scope,
  SecretMetadata,
} from "@saas/db/config";
import type { SqlExecutor, SqlExecutorResult, SqlRow } from "@saas/db/d1";

type QueryRecord = { text: string; params: unknown[] };

function createFakeExecutor(options?: {
  rows?: Record<string, unknown>[];
  error?: unknown;
  rowCount?: number;
}): { executor: SqlExecutor; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const executor: SqlExecutor = {
    async execute<T extends SqlRow = SqlRow>(
      text: string,
      params?: unknown[],
    ): Promise<SqlExecutorResult<T>> {
      queries.push({ text, params: params ?? [] });
      if (options?.error) {
        throw options.error;
      }
      const rows = (options?.rows ?? []) as unknown as T[];
      return { rows, rowCount: options?.rowCount ?? rows.length };
    },
  };
  return { executor, queries };
}

const NOW = new Date("2026-01-15T10:00:00Z");

const SAMPLE_SETTING_ROW = {
  id: "set-001",
  org_id: "org-001",
  project_id: null,
  environment_id: null,
  scope_kind: "organization",
  key: "theme",
  value: { dark: true },
  description: "UI theme",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_FLAG_ROW = {
  id: "flg-001",
  org_id: "org-001",
  project_id: null,
  environment_id: null,
  scope_kind: "organization",
  flag_key: "beta_feature",
  enabled: true,
  value: null,
  description: "Beta feature toggle",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const SAMPLE_SECRET_ROW = {
  id: "sec-001",
  org_id: "org-001",
  project_id: null,
  environment_id: null,
  scope_kind: "organization",
  secret_key: "DB_PASSWORD",
  display_name: "Database Password",
  status: "active",
  version: 1,
  rotation_policy: null,
  last_rotated_at: null,
  expires_at: null,
  created_by: "user-001",
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
};

const ORG_SCOPE: Scope = { kind: "organization", orgId: "org-001" };
const PROJECT_SCOPE: Scope = { kind: "project", orgId: "org-001", projectId: "prj-001" };
const ENV_SCOPE: Scope = { kind: "environment", orgId: "org-001", projectId: "prj-001", environmentId: "env-001" };

// ── Settings tests ─────────────────────────────────────────

describe("ConfigRepository — Settings", () => {
  it("creates an org-scoped setting with parameterized query", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SETTING_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-001",
      scope: ORG_SCOPE,
      key: "theme",
      value: { dark: true },
      description: "UI theme",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe("set-001");
      expect(result.value.scopeKind).toBe("organization");
      expect(result.value.projectId).toBeNull();
      expect(result.value.environmentId).toBeNull();
    }
    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("config_settings");
    expect(queries[0]!.params[2]).toBeNull(); // project_id null
    expect(queries[0]!.params[3]).toBeNull(); // environment_id null
  });

  it("creates a project-scoped setting with both orgId and projectId", async () => {
    const row = { ...SAMPLE_SETTING_ROW, project_id: "prj-001", scope_kind: "project" };
    const { executor, queries } = createFakeExecutor({ rows: [row] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-002",
      scope: PROJECT_SCOPE,
      key: "timeout",
      value: 30,
    });
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[1]).toBe("org-001"); // org_id
    expect(queries[0]!.params[2]).toBe("prj-001"); // project_id
    expect(queries[0]!.params[3]).toBeNull(); // environment_id
  });

  it("creates an environment-scoped setting with all three IDs", async () => {
    const row = { ...SAMPLE_SETTING_ROW, project_id: "prj-001", environment_id: "env-001", scope_kind: "environment" };
    const { executor, queries } = createFakeExecutor({ rows: [row] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-003",
      scope: ENV_SCOPE,
      key: "log_level",
      value: "debug",
    });
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[1]).toBe("org-001");
    expect(queries[0]!.params[2]).toBe("prj-001");
    expect(queries[0]!.params[3]).toBe("env-001");
  });

  it("returns conflict on unique violation", async () => {
    const { executor } = createFakeExecutor({ error: new Error("D1_ERROR: UNIQUE constraint failed") });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-001",
      scope: ORG_SCOPE,
      key: "theme",
      value: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("conflict");
    }
  });

  it("returns conflict when insert returns 0 rows", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-001",
      scope: ORG_SCOPE,
      key: "theme",
      value: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("conflict");
    }
  });

  it("returns internal error on check violation", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23514" } });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-001",
      scope: ORG_SCOPE,
      key: "theme",
      value: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("internal");
    }
  });

  it("updates a setting by orgId + settingId", async () => {
    const updatedRow = { ...SAMPLE_SETTING_ROW, value: { dark: false } };
    const { executor, queries } = createFakeExecutor({ rows: [updatedRow] });
    const repo = createConfigRepository(executor);
    const result = await repo.updateSetting("org-001", "set-001", { value: { dark: false } });
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("set-001");
  });

  it("returns not_found when updating a non-existent setting", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.updateSetting("org-001", "set-999", { value: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("gets a setting by orgId + settingId", async () => {
    const { executor } = createFakeExecutor({ rows: [SAMPLE_SETTING_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.getSetting("org-001", "set-001");
    expect(result.ok).toBe(true);
  });

  it("returns not_found for missing setting", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.getSetting("org-001", "nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("lists settings with org scope filter", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SETTING_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.listSettings(ORG_SCOPE, { limit: 10, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toHaveLength(1);
    expect(queries[0]!.text).toContain("scope_kind = 'organization'");
  });

  it("lists settings with project scope filter requiring orgId + projectId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createConfigRepository(executor);
    await repo.listSettings(PROJECT_SCOPE, { limit: 10, cursor: null });
    expect(queries[0]!.text).toContain("org_id = $1 AND project_id = $2");
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("prj-001");
  });

  it("lists settings with environment scope filter requiring all three IDs", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createConfigRepository(executor);
    await repo.listSettings(ENV_SCOPE, { limit: 10, cursor: null });
    expect(queries[0]!.text).toContain("org_id = $1 AND project_id = $2 AND environment_id = $3");
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("prj-001");
    expect(queries[0]!.params[2]).toBe("env-001");
  });

  it("supports cursor pagination in list", async () => {
    const rows = [
      { ...SAMPLE_SETTING_ROW, id: "set-a" },
      { ...SAMPLE_SETTING_ROW, id: "set-b" },
    ];
    const { executor } = createFakeExecutor({ rows });
    const repo = createConfigRepository(executor);
    const result = await repo.listSettings(ORG_SCOPE, { limit: 1, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(1);
      expect(result.value.nextCursor).not.toBeNull();
    }
  });
});

// ── Feature flags tests ────────────────────────────────────

describe("ConfigRepository — Feature Flags", () => {
  it("creates an org-scoped flag", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_FLAG_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.createFeatureFlag({
      id: "flg-001",
      scope: ORG_SCOPE,
      flagKey: "beta_feature",
      enabled: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.flagKey).toBe("beta_feature");
      expect(result.value.enabled).toBe(true);
    }
    expect(queries[0]!.text).toContain("config_feature_flags");
  });

  it("creates a project-scoped flag with orgId + projectId", async () => {
    const row = { ...SAMPLE_FLAG_ROW, project_id: "prj-001", scope_kind: "project" };
    const { executor, queries } = createFakeExecutor({ rows: [row] });
    const repo = createConfigRepository(executor);
    await repo.createFeatureFlag({
      id: "flg-002",
      scope: PROJECT_SCOPE,
      flagKey: "dark_mode",
    });
    expect(queries[0]!.params[2]).toBe("prj-001");
  });

  it("returns conflict on duplicate flag key", async () => {
    const { executor } = createFakeExecutor({ error: new Error("D1_ERROR: UNIQUE constraint failed") });
    const repo = createConfigRepository(executor);
    const result = await repo.createFeatureFlag({
      id: "flg-001",
      scope: ORG_SCOPE,
      flagKey: "beta_feature",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });

  it("updates a flag by orgId + flagId", async () => {
    const updatedRow = { ...SAMPLE_FLAG_ROW, enabled: false };
    const { executor, queries } = createFakeExecutor({ rows: [updatedRow] });
    const repo = createConfigRepository(executor);
    const result = await repo.updateFeatureFlag("org-001", "flg-001", { enabled: false });
    expect(result.ok).toBe(true);
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("flg-001");
  });

  it("returns not_found when updating a missing flag", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.updateFeatureFlag("org-001", "nope", { enabled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("gets a flag by orgId + flagId", async () => {
    const { executor } = createFakeExecutor({ rows: [SAMPLE_FLAG_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.getFeatureFlag("org-001", "flg-001");
    expect(result.ok).toBe(true);
  });

  it("lists flags with scope filter", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_FLAG_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.listFeatureFlags(ORG_SCOPE, { limit: 10, cursor: null });
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).toContain("config_feature_flags");
  });
});

// ── Secret metadata tests ──────────────────────────────────

describe("ConfigRepository — Secret Metadata", () => {
  it("creates secret metadata without exposing plaintext", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.createSecretMetadata({
      id: "sec-001",
      scope: ORG_SCOPE,
      secretKey: "DB_PASSWORD",
      displayName: "Database Password",
      createdBy: asUuid("00000000-0000-0000-0000-000000000001"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const val = result.value;
      // Must not have ciphertext_envelope or any plaintext secret field
      expect("ciphertext_envelope" in val).toBe(false);
      expect("ciphertextEnvelope" in val).toBe(false);
      expect("plaintext" in val).toBe(false);
      expect("secret_value" in val).toBe(false);
      expect("secretValue" in val).toBe(false);
      expect(val.secretKey).toBe("DB_PASSWORD");
      expect(val.status).toBe("active");
      expect(val.version).toBe(1);
    }
    // RETURNING clause must not include ciphertext_envelope
    expect(queries[0]!.text).not.toContain("ciphertext_envelope");
  });

  it("lists secret metadata without exposing ciphertext_envelope", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.listSecretMetadata(ORG_SCOPE, { limit: 10, cursor: null });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toHaveLength(1);
      const item = result.value.items[0]!;
      expect("ciphertext_envelope" in item).toBe(false);
      expect("ciphertextEnvelope" in item).toBe(false);
    }
    // SELECT must use safe columns, not *
    expect(queries[0]!.text).not.toContain("SELECT *");
    expect(queries[0]!.text).not.toContain("ciphertext_envelope");
  });

  it("gets secret metadata without exposing ciphertext_envelope", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);
    const result = await repo.getSecretMetadata("org-001", "sec-001");
    expect(result.ok).toBe(true);
    expect(queries[0]!.text).not.toContain("ciphertext_envelope");
    expect(queries[0]!.text).not.toContain("SELECT *");
  });

  it("rotates secret metadata (increments version)", async () => {
    const rotatedRow = { ...SAMPLE_SECRET_ROW, version: 2, last_rotated_at: NOW.toISOString() };
    const { executor, queries } = createFakeExecutor({ rows: [rotatedRow] });
    const repo = createConfigRepository(executor);
    const result = await repo.rotateSecretMetadata("org-001", "sec-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.version).toBe(2);
    }
    expect(queries[0]!.text).toContain("version = version + 1");
    expect(queries[0]!.text).toContain("status = 'active'");
    expect(queries[0]!.text).not.toContain("ciphertext_envelope");
  });

  it("revokes secret metadata", async () => {
    const revokedRow = { ...SAMPLE_SECRET_ROW, status: "revoked" };
    const { executor, queries } = createFakeExecutor({ rows: [revokedRow] });
    const repo = createConfigRepository(executor);
    const result = await repo.revokeSecretMetadata("org-001", "sec-001");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("revoked");
    }
    expect(queries[0]!.text).toContain("status = 'revoked'");
    expect(queries[0]!.text).not.toContain("ciphertext_envelope");
  });

  it("returns not_found when rotating non-existent secret", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.rotateSecretMetadata("org-001", "nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("returns not_found when revoking non-existent secret", async () => {
    const { executor } = createFakeExecutor({ rows: [], rowCount: 0 });
    const repo = createConfigRepository(executor);
    const result = await repo.revokeSecretMetadata("org-001", "nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("not_found");
  });

  it("lists secret metadata with project scope requiring orgId + projectId", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [] });
    const repo = createConfigRepository(executor);
    await repo.listSecretMetadata(PROJECT_SCOPE, { limit: 10, cursor: null });
    expect(queries[0]!.params[0]).toBe("org-001");
    expect(queries[0]!.params[1]).toBe("prj-001");
  });

  it("creates project-scoped secret with orgId + projectId", async () => {
    const row = { ...SAMPLE_SECRET_ROW, project_id: "prj-001", scope_kind: "project" };
    const { executor, queries } = createFakeExecutor({ rows: [row] });
    const repo = createConfigRepository(executor);
    await repo.createSecretMetadata({
      id: "sec-002",
      scope: PROJECT_SCOPE,
      secretKey: "API_TOKEN",
      createdBy: asUuid("00000000-0000-0000-0000-000000000001"),
    });
    expect(queries[0]!.params[1]).toBe("org-001");
    expect(queries[0]!.params[2]).toBe("prj-001");
    expect(queries[0]!.params[3]).toBeNull(); // environment_id
  });

  it("returns conflict on duplicate secret key", async () => {
    const { executor } = createFakeExecutor({ error: new Error("D1_ERROR: UNIQUE constraint failed") });
    const repo = createConfigRepository(executor);
    const result = await repo.createSecretMetadata({
      id: "sec-001",
      scope: ORG_SCOPE,
      secretKey: "DB_PASSWORD",
      createdBy: asUuid("00000000-0000-0000-0000-000000000001"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });
});

// ── Scope validation tests ─────────────────────────────────

describe("ConfigRepository — Scope Validation", () => {
  it("rejects setting creation when check constraint violated", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23514" } });
    const repo = createConfigRepository(executor);
    const result = await repo.createSetting({
      id: "set-bad",
      scope: ORG_SCOPE,
      key: "x",
      value: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal");
  });

  it("rejects flag creation when check constraint violated", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23514" } });
    const repo = createConfigRepository(executor);
    const result = await repo.createFeatureFlag({
      id: "flg-bad",
      scope: ORG_SCOPE,
      flagKey: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal");
  });

  it("rejects secret creation when check constraint violated", async () => {
    const { executor } = createFakeExecutor({ error: { code: "23514" } });
    const repo = createConfigRepository(executor);
    const result = await repo.createSecretMetadata({
      id: "sec-bad",
      scope: ORG_SCOPE,
      secretKey: "x",
      createdBy: asUuid("00000000-0000-0000-0000-000000000001"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("internal");
  });
});

// ── Secret safety invariants ───────────────────────────────

describe("Secret Safety Invariants", () => {
  it("SecretMetadata type does not include plaintext or ciphertext fields", () => {
    // This is a compile-time + runtime assertion
    const sample: SecretMetadata = {
      id: "x",
      orgId: "o",
      projectId: null,
      environmentId: null,
      scopeKind: "organization",
      secretKey: "k",
      displayName: null,
      status: "active",
      version: 1,
      rotationPolicy: null,
      lastRotatedAt: null,
      expiresAt: null,
      createdBy: asUuid("00000000-0000-0000-0000-000000000002"),
      createdAt: NOW,
      updatedAt: NOW,
    };
    const keys = Object.keys(sample);
    expect(keys).not.toContain("ciphertextEnvelope");
    expect(keys).not.toContain("ciphertext_envelope");
    expect(keys).not.toContain("plaintext");
    expect(keys).not.toContain("secretValue");
    expect(keys).not.toContain("secret_value");
    expect(keys).not.toContain("value");
  });

  it("repository read queries never SELECT * for secret_metadata", async () => {
    const { executor, queries } = createFakeExecutor({ rows: [SAMPLE_SECRET_ROW] });
    const repo = createConfigRepository(executor);

    await repo.getSecretMetadata("org-001", "sec-001");
    await repo.listSecretMetadata(ORG_SCOPE, { limit: 10, cursor: null });
    await repo.rotateSecretMetadata("org-001", "sec-001");
    await repo.revokeSecretMetadata("org-001", "sec-001");

    for (const q of queries) {
      expect(q.text).not.toContain("SELECT *");
      expect(q.text).not.toContain("ciphertext_envelope");
    }
  });
});
