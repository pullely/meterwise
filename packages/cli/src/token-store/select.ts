// Selection logic for the active token store.
//
// Decision tree:
//   1. If the caller injects a `KeytarLike` shim (tests / DI), use the
//      keychain store with that injection.
//   2. Otherwise attempt `loadKeytar()` once. On success → keychain.
//   3. On any error → file fallback.
//
// The selector caches the result for the lifetime of the process; commands
// don't re-probe keytar on every invocation.

import {
  KeychainTokenStore,
  loadKeytar,
  type KeychainTokenStoreOptions,
} from "./keychain.js";
import { FileTokenStore } from "./file.js";
import type { TokenStore } from "./types.js";

export interface SelectOptions {
  /** Force one or the other (mainly for tests). */
  readonly force?: "keychain" | "file";
  /** Inject a keytar shim. When set, keychain is selected unconditionally. */
  readonly keytar?: KeychainTokenStoreOptions["keytar"];
  /** Override the file store config dir. */
  readonly configDir?: string;
}

export async function selectTokenStore(opts: SelectOptions = {}): Promise<TokenStore> {
  if (opts.force === "file") {
    return new FileTokenStore(opts.configDir !== undefined ? { configDir: opts.configDir } : {});
  }
  if (opts.force === "keychain" || opts.keytar !== undefined) {
    return new KeychainTokenStore(opts.keytar !== undefined ? { keytar: opts.keytar } : {});
  }

  try {
    await loadKeytar();
    return new KeychainTokenStore();
  } catch {
    return new FileTokenStore(
      opts.configDir !== undefined ? { configDir: opts.configDir } : {},
    );
  }
}
