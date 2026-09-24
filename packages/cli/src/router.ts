// Command router. Hand-rolled (no `commander`/`cac`/`clipanion`) — see the
// implementer report's framework rationale: the pilot command surface is
// small (8 commands), argv parsing is trivial, and avoiding a new runtime
// dep keeps the package install footprint to `keytar` (optional) only.
//
// Shape:
//   - Commands register with a path (array of segments, e.g. `["org","list"]`).
//   - Argv tokens that start with `--` are parsed as flags; everything else
//     becomes a positional. `--key=value` and `--key value` both work.
//   - Boolean flags pass `true`. The first positional that does NOT match a
//     registered subcommand starts the positional list for that command.

import type { Meterwise } from "@saas/sdk";

import type { OutputMode } from "./output/index.js";
import type { TokenStore } from "./token-store/types.js";
import type { ContextStore } from "./context/store.js";

export interface CommandContext {
  readonly args: ReadonlyArray<string>;
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly outputMode: OutputMode;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly tokenStore: TokenStore;
  readonly contextStore: ContextStore;
  /**
   * Lazy SDK factory. Commands that need an authenticated client call this
   * to read the token from the token store and instantiate `Meterwise`.
   * Throws `MissingAuthError` (translated to a friendly message by `errors.ts`)
   * when no token is stored.
   */
  readonly sdk: () => Promise<Meterwise>;
}

export interface CommandResult {
  readonly exitCode: number;
}

export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult>;

interface Registered {
  readonly path: ReadonlyArray<string>;
  readonly handler: CommandHandler;
  readonly summary: string;
}

export class Router {
  private readonly entries: Registered[] = [];

  register(path: ReadonlyArray<string>, summary: string, handler: CommandHandler): void {
    this.entries.push({ path, summary, handler });
  }

  /**
   * Look up the longest registered command path that prefix-matches `argv`.
   * Returns the handler + remaining positional args, or `null` if no match.
   */
  resolve(
    argv: ReadonlyArray<string>,
  ): { handler: CommandHandler; rest: ReadonlyArray<string> } | null {
    let best: Registered | null = null;
    for (const entry of this.entries) {
      if (entry.path.length > argv.length) continue;
      let matches = true;
      for (let i = 0; i < entry.path.length; i++) {
        if (entry.path[i] !== argv[i]) {
          matches = false;
          break;
        }
      }
      if (matches && (best === null || entry.path.length > best.path.length)) {
        best = entry;
      }
    }
    if (!best) return null;
    return { handler: best.handler, rest: argv.slice(best.path.length) };
  }

  list(): ReadonlyArray<{ path: ReadonlyArray<string>; summary: string }> {
    return this.entries.map((e) => ({ path: e.path, summary: e.summary }));
  }
}

interface ParsedArgv {
  readonly positional: ReadonlyArray<string>;
  readonly flags: Readonly<Record<string, string | boolean>>;
}

/**
 * Minimal argv parser. Recognises:
 *   - `--key=value`             → flags[key] = "value"
 *   - `--key value`             → flags[key] = "value" (when next token is
 *                                 not itself a `--flag`)
 *   - `--key`                   → flags[key] = true
 *   - everything else           → positional
 *
 * Stops consuming flags on the first `--` separator (everything after is
 * positional).
 */
export function parseArgv(argv: ReadonlyArray<string>): ParsedArgv {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  let separator = false;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined) {
      i += 1;
      continue;
    }
    if (separator) {
      positional.push(token);
      i += 1;
      continue;
    }
    if (token === "--") {
      separator = true;
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        i += 1;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i += 2;
        continue;
      }
      flags[body] = true;
      i += 1;
      continue;
    }
    positional.push(token);
    i += 1;
  }
  return { positional, flags };
}
