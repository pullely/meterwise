import type { D1Binding } from "./binding.js";

export interface DbHealthResult {
  configured: boolean;
  reachable: boolean;
}

export interface D1Adapter {
  ping(): Promise<DbHealthResult>;
  dispose(): Promise<void>;
}

/**
 * Health probe for the platform database.
 *
 * `configured` answers "is the binding present in this environment's wrangler
 * config"; `reachable` answers "did a trivial statement actually return". They
 * are separate because a missing binding is an operator/wiring problem and an
 * unreachable database is a platform problem, and the health endpoint should
 * not conflate them.
 */
export function createD1Adapter(binding: D1Binding | undefined | null): D1Adapter {
  return {
    async ping(): Promise<DbHealthResult> {
      if (!binding) return { configured: false, reachable: false };
      try {
        await binding.prepare("SELECT 1 AS ok").all();
        return { configured: true, reachable: true };
      } catch {
        return { configured: true, reachable: false };
      }
    },

    async dispose(): Promise<void> {
      // Nothing to release: a D1 binding holds no connection.
    },
  };
}
