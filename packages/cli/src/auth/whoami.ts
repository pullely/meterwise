// `meterwise whoami` — read token + cached context, validate via SDK.

import { Meterwise } from "@saas/sdk";

import type { OutputMode } from "../output/index.js";
import { formatOutput } from "../output/index.js";
import type { ContextStore } from "../context/store.js";
import type { TokenStore } from "../token-store/types.js";
import { MissingAuthError } from "../errors.js";

export interface WhoamiInput {
  readonly outputMode: OutputMode;
  readonly tokenStore: TokenStore;
  readonly contextStore: ContextStore;
  readonly stdout: (line: string) => void;
  /** SDK factory override for tests. Defaults to constructing `Meterwise`. */
  readonly sdkFactory?: (baseUrl: string, token: string) => Meterwise;
}

export interface WhoamiOutcome {
  readonly apiUrl: string;
  readonly activeOrgId: string | null;
  readonly orgCount: number;
}

export async function whoamiFlow(input: WhoamiInput): Promise<WhoamiOutcome> {
  const cred = await input.tokenStore.load();
  if (!cred) throw new MissingAuthError();

  const client =
    input.sdkFactory?.(cred.apiUrl, cred.token) ??
    new Meterwise({
      baseUrl: cred.apiUrl,
      auth: { kind: "bearer", token: cred.token },
    });

  const ctx = await input.contextStore.load();
  const result = await client.organizations.list();
  const orgCount = result.organizations.length;
  const activeOrgId = ctx.activeOrgId ?? null;

  if (input.outputMode === "json") {
    input.stdout(
      formatOutput({
        mode: "json",
        data: {
          apiUrl: cred.apiUrl,
          activeOrgId,
          organizations: orgCount,
        },
      }),
    );
  } else {
    input.stdout(
      formatOutput({
        mode: "human",
        record: {
          apiUrl: cred.apiUrl,
          activeOrg: activeOrgId ?? "(none)",
          organizations: String(orgCount),
        },
      }),
    );
  }

  return { apiUrl: cred.apiUrl, activeOrgId, orgCount };
}
