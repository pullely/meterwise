// Branded UUID identifier + decode helpers live in `./ids` (`@saas/db/ids`).
export { isUuid, asUuid, uuidFromPublicId } from "./ids/index.js";
export type { Uuid } from "./ids/index.js";

export const BOUNDED_CONTEXTS = [
  "control",
  "identity",
  "membership",
  "projects",
  "billing",
  "events",
  "config",
  "webhooks",
  "metering",
  "notifications",
  "support",
  "integrations",
] as const;

export type BoundedContext = (typeof BOUNDED_CONTEXTS)[number];

export interface MigrationEntry {
  id: string;
  context: BoundedContext;
  path: string;
  checksum: string;
  description: string;
}

export interface MigrationManifest {
  version: 1;
  migrations: MigrationEntry[];
}
