// Active CLI context — `~/.config/meterwise/config.json`.
//
// Records the active org id and the last-used api-url. Mode 0644 (it's not
// a secret). `org list` prints the active marker; `org use <id>` writes
// here; `whoami` reads here.

import { promises as fs } from "node:fs";
import * as path from "node:path";

import { resolveConfigDir } from "../config-paths.js";

const FILE_BASENAME = "config.json";

export interface CliContext {
  readonly activeOrgId?: string;
  readonly lastApiUrl?: string;
}

export interface ContextStoreOptions {
  readonly configDir?: string;
}

export class ContextStore {
  private readonly configDir: string;

  constructor(opts: ContextStoreOptions = {}) {
    this.configDir = opts.configDir ?? resolveConfigDir();
  }

  get filePath(): string {
    return path.join(this.configDir, FILE_BASENAME);
  }

  async load(): Promise<CliContext> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return {};
      }
      if (!isCliContext(parsed)) return {};
      return parsed;
    } catch (err) {
      if (isNotFound(err)) return {};
      throw err;
    }
  }

  async save(ctx: CliContext): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(ctx, null, 2), { mode: 0o644 });
    await fs.rename(tmp, this.filePath);
  }

  async setActiveOrg(orgId: string): Promise<CliContext> {
    const current = await this.load();
    const next: CliContext = { ...current, activeOrgId: orgId };
    await this.save(next);
    return next;
  }

  async setLastApiUrl(url: string): Promise<CliContext> {
    const current = await this.load();
    const next: CliContext = { ...current, lastApiUrl: url };
    await this.save(next);
    return next;
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

function isCliContext(value: unknown): value is CliContext {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v["activeOrgId"] !== undefined && typeof v["activeOrgId"] !== "string") return false;
  if (v["lastApiUrl"] !== undefined && typeof v["lastApiUrl"] !== "string") return false;
  return true;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}
