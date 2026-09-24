import type { GetLlmPricesResponse } from "@saas/contracts/ledger";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { notFound, successResponse } from "../http.js";
import { toPublicPrice, toPublicVersion } from "../present.js";
import { withDb } from "./common.js";

/** GET /v1/organizations/{org}/llm-prices?version= — the versions, and one version's cited rows (default: the latest). */
export async function handlePrices(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  return withDb(env, requestId, actor, orgId, "ledger.read", async (db) => {
    const versions = await db.ledger.listPriceVersions();
    const wanted = new URL(request.url).searchParams.get("version");
    const version = wanted ?? versions[0]?.version ?? null;
    if (wanted !== null && !versions.some((v) => v.version === wanted)) return notFound(requestId);
    const prices = version ? await db.ledger.listModelPrices(version) : [];
    const body: GetLlmPricesResponse = {
      versions: versions.map(toPublicVersion),
      version,
      prices: prices.map(toPublicPrice),
    };
    return successResponse(body, requestId);
  });
}
