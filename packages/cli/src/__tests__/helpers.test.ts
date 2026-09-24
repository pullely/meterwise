// Tests for the shared CLI command helpers (Task 0111).
//
// These cover the byte-equivalent extraction of `resolveOrgId` (from
// `writes.ts`) and `readIdempotencyKey` (from both `writes.ts` and
// `webhook-secrets-rotate.ts`) into `commands/helpers.ts`. The
// helpers depend on `CommandContext.flags` and
// `CommandContext.contextStore.load()` only, so we build minimal
// fixtures rather than going through `runCli`. Black-box behavioural
// coverage of the full command pipeline already lives in
// `webhook-secrets-rotate.test.ts` and `writes-and-cross-reads.test.ts`;
// this file is the unit slice for the extracted module.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import type { CommandContext } from "../router.js";
import {
  resolveOrgId,
  readIdempotencyKey,
} from "../commands/helpers.js";
import { ContextStore } from "../context/store.js";
import { MissingOrgContextError } from "../errors.js";
import { MemoryTokenStore } from "./helpers.js";

// ---- minimal CommandContext fixture --------------------------------------

async function withCtx(
  flags: Readonly<Record<string, string | boolean>>,
  options: { activeOrgId?: string | null } = {},
  fn: (ctx: CommandContext) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-task0111-"));
  try {
    const contextStore = new ContextStore({ configDir: dir });
    if (
      options.activeOrgId !== undefined &&
      options.activeOrgId !== null &&
      options.activeOrgId.length > 0
    ) {
      await contextStore.setActiveOrg(options.activeOrgId);
    }
    const ctx: CommandContext = {
      args: [],
      flags,
      outputMode: "human",
      stdout: () => {},
      stderr: () => {},
      tokenStore: new MemoryTokenStore(),
      contextStore,
      sdk: () => {
        throw new Error("sdk() should not be called by helpers under test");
      },
    };
    await fn(ctx);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---- resolveOrgId --------------------------------------------------------

describe("resolveOrgId", () => {
  it("returns the --org flag value when allowOverride=true and flag is non-empty", async () => {
    await withCtx(
      { org: "org_flag" },
      { activeOrgId: "org_persisted" },
      async (ctx) => {
        const got = await resolveOrgId(ctx, true);
        expect(got).toBe("org_flag");
      },
    );
  });

  it("falls back to persisted activeOrgId when allowOverride=true and flag is absent", async () => {
    await withCtx(
      {},
      { activeOrgId: "org_persisted" },
      async (ctx) => {
        const got = await resolveOrgId(ctx, true);
        expect(got).toBe("org_persisted");
      },
    );
  });

  it("ignores the --org flag and uses persisted activeOrgId when allowOverride=false", async () => {
    await withCtx(
      { org: "org_flag" },
      { activeOrgId: "org_persisted" },
      async (ctx) => {
        const got = await resolveOrgId(ctx, false);
        expect(got).toBe("org_persisted");
      },
    );
  });

  it("throws MissingOrgContextError when neither flag (where applicable) nor activeOrgId is set", async () => {
    // allowOverride=true with no flag and no persisted org.
    await withCtx({}, {}, async (ctx) => {
      await expect(resolveOrgId(ctx, true)).rejects.toBeInstanceOf(
        MissingOrgContextError,
      );
    });
    // allowOverride=false with a flag set but no persisted org — flag is
    // ignored and the missing-context error must still fire.
    await withCtx({ org: "org_flag" }, {}, async (ctx) => {
      await expect(resolveOrgId(ctx, false)).rejects.toBeInstanceOf(
        MissingOrgContextError,
      );
    });
  });

  it("falls back to persisted activeOrgId when allowOverride=true and the flag is an empty string", async () => {
    await withCtx(
      { org: "" },
      { activeOrgId: "org_persisted" },
      async (ctx) => {
        const got = await resolveOrgId(ctx, true);
        expect(got).toBe("org_persisted");
      },
    );
  });

  it("treats a boolean true --org flag (bare --org with no value) as absent and falls back to persisted activeOrgId", async () => {
    await withCtx(
      { org: true },
      { activeOrgId: "org_persisted" },
      async (ctx) => {
        const got = await resolveOrgId(ctx, true);
        expect(got).toBe("org_persisted");
      },
    );
  });
});

// ---- readIdempotencyKey --------------------------------------------------

describe("readIdempotencyKey", () => {
  it("returns the flag value verbatim when it is a non-empty string", async () => {
    await withCtx({ "idempotency-key": "abc-123" }, {}, async (ctx) => {
      expect(readIdempotencyKey(ctx)).toBe("abc-123");
    });
  });

  it("returns undefined when the flag is missing, false, true, or an empty string", async () => {
    await withCtx({}, {}, async (ctx) => {
      expect(readIdempotencyKey(ctx)).toBeUndefined();
    });
    await withCtx({ "idempotency-key": false }, {}, async (ctx) => {
      expect(readIdempotencyKey(ctx)).toBeUndefined();
    });
    await withCtx({ "idempotency-key": true }, {}, async (ctx) => {
      expect(readIdempotencyKey(ctx)).toBeUndefined();
    });
    await withCtx({ "idempotency-key": "" }, {}, async (ctx) => {
      expect(readIdempotencyKey(ctx)).toBeUndefined();
    });
  });
});
