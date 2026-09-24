// `~/.config/meterwise/credentials.json` token store fallback.
//
// Behaviour:
//   - Parent dir is created with mode 0700 if missing.
//   - File is written with mode 0600 atomically (write to tmp, rename) so
//     a partial failure doesn't leave a half-written credential file.
//   - Path is overrideable via `METERWISE_CONFIG_DIR` for tests.
//   - On Windows, mode bits are advisory; the chmod calls succeed silently
//     against ACL-backed FS but the test asserts mode only on POSIX.

import { constants as fsConstants, promises as fs } from "node:fs";
import * as path from "node:path";

import type { StoredCredential, TokenStore } from "./types.js";
import { resolveConfigDir } from "../config-paths.js";

const FILE_BASENAME = "credentials.json";

export interface FileTokenStoreOptions {
  /** Override the config dir entirely. Defaults to `resolveConfigDir()`. */
  readonly configDir?: string;
}

export class FileTokenStore implements TokenStore {
  readonly kind = "file" as const;

  private readonly configDir: string;

  constructor(opts: FileTokenStoreOptions = {}) {
    this.configDir = opts.configDir ?? resolveConfigDir();
  }

  get filePath(): string {
    return path.join(this.configDir, FILE_BASENAME);
  }

  async load(): Promise<StoredCredential | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      if (!isStoredCredential(parsed)) return null;
      return parsed;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async save(cred: StoredCredential): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true, mode: 0o700 });
    // Existing dir may have looser perms; tighten now.
    await tryChmod(this.configDir, 0o700);

    const tmp = `${this.filePath}.tmp`;
    const data = JSON.stringify(cred, null, 2);
    await fs.writeFile(tmp, data, { mode: 0o600, flag: "w" });
    await tryChmod(tmp, 0o600);
    await fs.rename(tmp, this.filePath);
    // rename preserves perms on POSIX; chmod again for paranoia / Windows.
    await tryChmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["apiUrl"] === "string" && typeof v["token"] === "string";
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

async function tryChmod(target: string, mode: number): Promise<void> {
  try {
    await fs.chmod(target, mode);
  } catch {
    // Best effort — Windows ACL FS doesn't honour POSIX bits, and `chmod`
    // can fail on read-only mounts. The 0600 invariant is still asserted
    // by the POSIX test; this swallow is the documented Windows fallback.
  }
}

// Re-exported for tests that want to assert mode.
export { fsConstants };
