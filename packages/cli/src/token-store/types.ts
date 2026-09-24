// TokenStore adapter interface. Two implementations:
//   - KeychainTokenStore (lazy `keytar` import)
//   - FileTokenStore (~/.config/meterwise/credentials.json, mode 0600)
//
// The CLI selects a store at runtime via `selectTokenStore()`, preferring
// keychain when `keytar` loads. Both round-trip a `{ apiUrl, token }`
// record. Tests inject a stub via DI — no real keychain in unit tests.

export interface StoredCredential {
  readonly apiUrl: string;
  readonly token: string;
}

export interface TokenStore {
  readonly kind: "keychain" | "file" | "memory";
  load(): Promise<StoredCredential | null>;
  save(cred: StoredCredential): Promise<void>;
  clear(): Promise<void>;
}
