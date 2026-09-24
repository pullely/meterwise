// `meterwise logout` — clear token + active org context.

import type { OutputMode } from "../output/index.js";
import { formatOutput } from "../output/index.js";
import type { ContextStore } from "../context/store.js";
import type { TokenStore } from "../token-store/types.js";

export interface LogoutInput {
  readonly outputMode: OutputMode;
  readonly tokenStore: TokenStore;
  readonly contextStore: ContextStore;
  readonly stdout: (line: string) => void;
}

export async function logoutFlow(input: LogoutInput): Promise<void> {
  await input.tokenStore.clear();
  await input.contextStore.clear();
  if (input.outputMode === "json") {
    input.stdout(formatOutput({ mode: "json", data: { ok: true } }));
  } else {
    input.stdout("✓ Logged out (credentials and context cleared).");
  }
}
