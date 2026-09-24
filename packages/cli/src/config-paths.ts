// Resolves the on-disk config directory used by both the token-store file
// fallback and the context store.
//
// Layout (per task scope §Integration Notes):
//   - `~/.config/meterwise/credentials.json` (0600)
//   - `~/.config/meterwise/config.json`     (0644)
//
// Override via `METERWISE_CONFIG_DIR` (used heavily by tests).

import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_APP_DIR, CONFIG_DIR_ENV_VAR } from "./brand.js";

const APP_DIR = CONFIG_APP_DIR;

export function resolveConfigDir(): string {
  const override = process.env[CONFIG_DIR_ENV_VAR];
  if (override && override.length > 0) return override;
  // Honour `XDG_CONFIG_HOME` when set (Linux convention) so XDG users get
  // the dir they expect; fall back to `~/.config/meterwise` everywhere
  // else (macOS, Windows w/o XDG, Linux w/o XDG).
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.length > 0) return path.join(xdg, APP_DIR);
  return path.join(os.homedir(), ".config", APP_DIR);
}
