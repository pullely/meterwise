import { costNanoUsd, modelCandidates } from "@saas/contracts/ledger";
import type { LedgerPriceStatus, LedgerRepository, ModelPrice, PriceVersion } from "@saas/db/ledger";

export interface Pricing {
  priceStatus: LedgerPriceStatus;
  priceVersion: string | null;
  pricedModel: string | null;
  inputPriceMicros: number | null;
  outputPriceMicros: number | null;
  costNanoUsd: number | null;
}

const UNPRICED = { priceVersion: null, pricedModel: null, inputPriceMicros: null, outputPriceMicros: null, costNanoUsd: null };

/**
 * The price table as one request sees it (design §2.3, §2.4). Versions are
 * loaded once per request, and a version's rows only when an event needs them.
 */
export class PriceBook {
  private readonly rows = new Map<string, Map<string, ModelPrice>>();

  private constructor(
    private readonly repo: LedgerRepository,
    /** Newest first. */
    readonly versions: PriceVersion[],
  ) {}

  static async load(repo: LedgerRepository): Promise<PriceBook> {
    return new PriceBook(repo, await repo.listPriceVersions());
  }

  /** The latest version in effect at `occurredAt`, or null before the first. */
  versionAt(occurredAt: string): PriceVersion | null {
    const t = Date.parse(occurredAt);
    return this.versions.find((v) => Date.parse(v.effectiveFrom) <= t) ?? null;
  }

  private async table(version: string): Promise<Map<string, ModelPrice>> {
    let m = this.rows.get(version);
    if (!m) {
      m = new Map((await this.repo.listModelPrices(version)).map((p) => [`${p.provider}\u0000${p.model}`, p]));
      this.rows.set(version, m);
    }
    return m;
  }

  /** Price one call: exact model first, then one snapshot suffix stripped; never a prefix match. */
  async price(provider: string, model: string, inputTokens: number, outputTokens: number, occurredAt: string): Promise<Pricing> {
    const version = this.versionAt(occurredAt);
    if (!version) return { priceStatus: "before_price_table", ...UNPRICED };
    const table = await this.table(version.version);
    for (const candidate of modelCandidates(model)) {
      const row = table.get(`${provider}\u0000${candidate}`);
      if (!row) continue;
      return {
        priceStatus: "priced",
        priceVersion: version.version,
        pricedModel: row.model,
        inputPriceMicros: row.inputMicrosPerMtok,
        outputPriceMicros: row.outputMicrosPerMtok,
        costNanoUsd: costNanoUsd(inputTokens, outputTokens, row.inputMicrosPerMtok, row.outputMicrosPerMtok),
      };
    }
    return { priceStatus: "unknown_model", ...UNPRICED };
  }
}

/** SHA-256 over an event's canonical content: tells a retry (same) from a reused eventId (different). */
export async function fingerprint(e: {
  tenant: string;
  feature: string | null;
  user: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<string> {
  const canonical = JSON.stringify([e.tenant, e.feature, e.user, e.provider, e.model, e.inputTokens, e.outputTokens]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
