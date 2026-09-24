-- 190_integrations_delivery_attribution: connection pointer on the inbox (IG2).
--
-- Context: integrations
-- Epic: saas-integrations (IG2) — the cron drain attributes each inbound
--       delivery installation → connection → org. The org pointer landed in
--       180; this adds the connection pointer so the console-facing delivery
--       log (`GET .../integrations/{id}/deliveries`) can scope per connection
--       instead of mixing every provider connection in the organization.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS; nullable (NULL until the
-- drain attributes the delivery, exactly like org_id); partial index so
-- unattributed rows add no index cost.

ALTER TABLE integrations_inbound_deliveries ADD COLUMN connection_id TEXT;

-- column integrations_inbound_deliveries.connection_id: Owning connection once the drain attributes the delivery (installation -> connection -> org); NULL until attributed. Opaque id, no foreign key, consistent with the schema convention.

CREATE INDEX IF NOT EXISTS idx_integrations_inbound_deliveries_connection
  ON integrations_inbound_deliveries (connection_id, received_at DESC, id DESC)
  WHERE connection_id IS NOT NULL;
