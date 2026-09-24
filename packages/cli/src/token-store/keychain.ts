// Keychain-backed token store. Lazily imports `keytar` so the package
// index stays loadable in non-Node environments (Workers, Bun) and in
// CI environments that lack native build tools.
//
// PR Boundary §2 / Constraints §1: `keytar` is in `optionalDependencies`
// AND must NOT be a transitive runtime requirement of the package index.
// `loadKeytar()` is the one and only place we touch it.

import type { StoredCredential, TokenStore } from "./types.js";
import { KEYCHAIN_SERVICE } from "../brand.js";

const SERVICE = KEYCHAIN_SERVICE;
const ACCOUNT = "default";

interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export interface KeychainTokenStoreOptions {
  /** Inject a keytar-shaped module (used heavily by tests). */
  readonly keytar?: KeytarLike;
}

export class KeychainTokenStore implements TokenStore {
  readonly kind = "keychain" as const;

  private readonly injected: KeytarLike | undefined;

  constructor(opts: KeychainTokenStoreOptions = {}) {
    this.injected = opts.keytar;
  }

  private async resolve(): Promise<KeytarLike> {
    if (this.injected) return this.injected;
    return loadKeytar();
  }

  async load(): Promise<StoredCredential | null> {
    const k = await this.resolve();
    const raw = await k.getPassword(SERVICE, ACCOUNT);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isStoredCredential(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async save(cred: StoredCredential): Promise<void> {
    const k = await this.resolve();
    await k.setPassword(SERVICE, ACCOUNT, JSON.stringify(cred));
  }

  async clear(): Promise<void> {
    const k = await this.resolve();
    await k.deletePassword(SERVICE, ACCOUNT);
  }
}

/**
 * Dynamic-import keytar. Returns the module's default-shaped surface or
 * throws — caller decides whether to fall back to the file store.
 *
 * NOTE: this function exists so unit tests can stub the import path. The
 * package index re-exports `KeychainTokenStore` but NOT `loadKeytar`; the
 * latter is intentionally an internal seam.
 */
export async function loadKeytar(): Promise<KeytarLike> {
  // Dynamic import via a runtime-built specifier — bundlers / non-Node
  // hosts that never call this function never pay the cost. The string
  // assembly keeps TypeScript from resolving the module at compile time
  // so the package builds in environments where `keytar` is absent (it's
  // `optionalDependencies`, install can succeed without it).
  const moduleName = ["key", "tar"].join("");
  const mod: unknown = await import(/* @vite-ignore */ moduleName);
  if (!isKeytarLike(mod)) {
    // Some bundlers wrap CJS exports in a `default` property.
    const wrapped =
      typeof mod === "object" && mod !== null
        ? (mod as { default?: unknown }).default
        : null;
    if (isKeytarLike(wrapped)) return wrapped;
    throw new Error("keytar module did not expose the expected surface");
  }
  return mod;
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["apiUrl"] === "string" && typeof v["token"] === "string";
}

function isKeytarLike(value: unknown): value is KeytarLike {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["setPassword"] === "function" &&
    typeof v["getPassword"] === "function" &&
    typeof v["deletePassword"] === "function"
  );
}
