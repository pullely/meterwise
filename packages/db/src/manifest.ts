import type { MigrationManifest } from "./types.js";

export const manifest: MigrationManifest = {
  version: 1,
  migrations: [
    {
      id: "000_control_baseline",
      context: "control",
      path: "000_control/up.sql",
      checksum:
        "c7f11499fa82d6fd2baa1af7fc75eeb73cd7be252af2e56841509c66001d638b",
      description:
        "Baseline control migration — creates the migration tracking schema",
    },
    {
      id: "010_identity_core",
      context: "identity",
      path: "010_identity_core/up.sql",
      checksum:
        "e8275904e2c60c42c6c977c208acd857086c6b93b35f552fd10e41ca16607872",
      description:
        "Identity persistence foundation — users, auth identities, login challenges, sessions",
    },
    {
      id: "020_membership_core",
      context: "membership",
      path: "020_membership_core/up.sql",
      checksum:
        "857bbac3e351b71a2549e6639127611e0918a16a6efe94fe0edb8d12dc7392d5",
      description:
        "Membership persistence foundation — organizations, members, invitations, role assignments",
    },
    {
      id: "030_events_audit_core",
      context: "events",
      path: "030_events_audit_core/up.sql",
      checksum:
        "13c451ca150371f301a85c3a00b36689a6108f31da05c8d1a3fa64b3b1b6bfb4",
      description:
        "Events/audit persistence foundation — canonical event log and audit entry projections",
    },
    {
      id: "040_projects_core",
      context: "projects",
      path: "040_projects_core/up.sql",
      checksum:
        "f40bd14d98f399f0a0cfb6f82a5ac7be31792c74950e597bc90ffe6a6ead3949",
      description:
        "Projects persistence foundation — projects and environments tables with tenant isolation",
    },
    {
      id: "050_identity_security_events",
      context: "identity",
      path: "050_identity_security_events/up.sql",
      checksum:
        "e97f0dc7d4e7f3e246bbdd80f041a64a178949281e30c9e94ceb8a64d9472009",
      description:
        "Identity-owned security-event source facts — pre-organization user activity log",
    },
    {
      id: "060_identity_api_keys",
      context: "identity",
      path: "060_identity_api_keys/up.sql",
      checksum:
        "9adceb6281c2f88449415dceba7f387e16591ffbc115d6199a5efce4acf92aff",
      description:
        "Identity-owned service principals and API keys — org-bound automation actors and credential persistence",
    },
    {
      id: "070_config_settings_flags",
      context: "config",
      path: "070_config_settings_flags/up.sql",
      checksum:
        "0996c9c8e483b1aff84a2b17e4176eaa21316f3c9834070eaee78c23c0b18a48",
      description:
        "Config persistence foundation — scoped settings, feature flags, and secret metadata",
    },
    {
      id: "080_webhooks_core",
      context: "webhooks",
      path: "080_webhooks_core/up.sql",
      checksum:
        "c9157f4836d229b73dd3918b0b090fc776e0ba73727a876e37a2b6c1b098a38a",
      description:
        "Webhook persistence foundation — endpoints, subscriptions, and delivery attempts",
    },
    {
      id: "090_webhooks_delivery",
      context: "webhooks",
      path: "090_webhooks_delivery/up.sql",
      checksum:
        "79ea5500c1e5dff36f70ad6a3f63f4335c1423c4695ca0ac5b60942d6f20cce4",
      description:
        "Webhook delivery runtime — fixes event_id type, adds dispatch cursor and delivery indexes",
    },
    {
      id: "100_metering_foundation",
      context: "metering",
      path: "100_metering_foundation/up.sql",
      checksum:
        "f5448db51935ade1fab8670a27c1104d20b07d0003608550d1749a013f0ac6b9",
      description:
        "Metering persistence foundation — usage records, rollups, quota definitions, and quota violations",
    },
    {
      id: "110_billing_foundation",
      context: "billing",
      path: "110_billing_foundation/up.sql",
      checksum:
        "446e002fada272b2488c745eb855f49685e7f9899297c8df7e39f25ad591e06f",
      description:
        "Billing persistence foundation — provider-neutral plans, billing customers, subscriptions, invoices, and entitlements",
    },
    {
      id: "120_notifications_core",
      context: "notifications",
      path: "120_notifications_core/up.sql",
      checksum:
        "ca99fc52528d2697885776096ee0d0b2b46cab6c18ca37cfc6e46ed4cf0b4d59",
      description:
        "Notifications persistence foundation — preferences, notifications, attempts, suppressions",
    },
    {
      id: "130_webhook_secret_rotation_grace",
      context: "webhooks",
      path: "130_webhook_secret_rotation_grace/up.sql",
      checksum:
        "de5929da0705b34ae3ac94ce978705c857d232997f553ed4abd92996b9ba8134",
      description:
        "Dual-secret rotation window — adds previous_secret_{ciphertext,version,expires_at} for grace-period delivery signing",
    },
    {
      id: "140_support_action_records",
      context: "support",
      path: "140_support_action_records/up.sql",
      checksum:
        "4379358a3692ebc734c1125c3d21c00c023185f42572351d7366f3292388b4b3",
      description:
        "Support persistence foundation — append-only audited support-action ledger owned by the admin-support worker",
    },
    {
      id: "150_entitlement_decision_observations",
      context: "billing",
      path: "150_entitlement_decision_observations/up.sql",
      checksum:
        "51950b97f41b5b03107cf1414a068e5d2a82901331f00687aa647139f40043d5",
      description:
        "Entitlement-decision observability — append-only, counts-only observation table (org × entitlement key × outcome) owned by the billing context",
    },
    {
      id: "160_identity_user_last_org",
      context: "identity",
      path: "160_identity_user_last_org/up.sql",
      checksum:
        "ebfead333c9a5ccfdc782744eef2911ae9c63c70358a8fccecbd8b545a851806",
      description:
        "Per-user last-viewed organization preference (nullable slug hint on identity_users) backing the console's cross-device default landing",
    },
    {
      id: "170_membership_org_parent",
      context: "membership",
      path: "170_membership_org_parent/up.sql",
      checksum:
        "33e280e66b1752832a434fb122d41733e1c325faa443e819a8b402ca63995581",
      description:
        "Optional parent-organization pointer (nullable parent_org_id on membership_organizations) — the dormant seam for the saas-multi-org-billing epic; NULL = standalone, no behavior change",
    },
    {
      id: "180_integrations_foundation",
      context: "integrations",
      path: "180_integrations_foundation/up.sql",
      checksum:
        "f0a65edf90d7d63349628335ca80ddf825555b1686c4873aa4f75ab633b8f2bd",
      description:
        "Integrations persistence foundation (IG0, dormant) — provider-agnostic connections, GitHub installation facts, repo links with branch→environment maps, the durable inbound-delivery inbox, and the encrypted installation-token cache",
    },
    {
      id: "190_integrations_delivery_attribution",
      context: "integrations",
      path: "190_integrations_delivery_attribution/up.sql",
      checksum:
        "b5ffe67f60e3486b9c733146c375341e757145b5d4381475256f1399328d81a0",
      description:
        "Connection pointer on the inbound-delivery inbox (nullable connection_id + partial index) — lets the per-connection delivery log scope precisely; attributed by the IG2 cron drain",
    },
  ],
};
