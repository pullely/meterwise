import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileTokenStore } from "../token-store/file.js";
import { KeychainTokenStore } from "../token-store/keychain.js";
import { selectTokenStore } from "../token-store/select.js";

interface KeytarShim {
  setPassword: (s: string, a: string, p: string) => Promise<void>;
  getPassword: (s: string, a: string) => Promise<string | null>;
  deletePassword: (s: string, a: string) => Promise<boolean>;
}

function makeShim(): KeytarShim & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async setPassword(s, a, p) {
      store.set(`${s}::${a}`, p);
    },
    async getPassword(s, a) {
      return store.get(`${s}::${a}`) ?? null;
    },
    async deletePassword(s, a) {
      return store.delete(`${s}::${a}`);
    },
  };
}

describe("FileTokenStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cli-token-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns null when file is missing", async () => {
    const store = new FileTokenStore({ configDir: dir });
    expect(await store.load()).toBeNull();
  });

  it("round-trips a credential", async () => {
    const store = new FileTokenStore({ configDir: dir });
    await store.save({ apiUrl: "https://api.test", token: "tok_x" });
    const loaded = await store.load();
    expect(loaded).toEqual({ apiUrl: "https://api.test", token: "tok_x" });
  });

  it("creates the credentials file with mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;
    const store = new FileTokenStore({ configDir: dir });
    await store.save({ apiUrl: "https://api.test", token: "tok" });
    const stat = await fs.stat(store.filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("creates the parent directory with mode 0700 on POSIX", async () => {
    if (process.platform === "win32") return;
    const nested = path.join(dir, "meterwise");
    const store = new FileTokenStore({ configDir: nested });
    await store.save({ apiUrl: "https://api.test", token: "tok" });
    const stat = await fs.stat(nested);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("clear() removes the file (idempotent)", async () => {
    const store = new FileTokenStore({ configDir: dir });
    await store.save({ apiUrl: "u", token: "t" });
    await store.clear();
    expect(await store.load()).toBeNull();
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    const store = new FileTokenStore({ configDir: dir });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(store.filePath, "not json", { mode: 0o600 });
    expect(await store.load()).toBeNull();
  });
});

describe("KeychainTokenStore (DI shim)", () => {
  it("round-trips via the injected shim", async () => {
    const shim = makeShim();
    const store = new KeychainTokenStore({ keytar: shim });
    await store.save({ apiUrl: "https://api.test", token: "tok" });
    expect(shim.store.size).toBe(1);
    const loaded = await store.load();
    expect(loaded).toEqual({ apiUrl: "https://api.test", token: "tok" });
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("returns null for non-JSON keychain values", async () => {
    const shim = makeShim();
    shim.store.set("meterwise-cli::default", "garbage");
    const store = new KeychainTokenStore({ keytar: shim });
    expect(await store.load()).toBeNull();
  });
});

describe("selectTokenStore", () => {
  it("force=keychain with a shim selects keychain", async () => {
    const shim = makeShim();
    const store = await selectTokenStore({ keytar: shim });
    expect(store.kind).toBe("keychain");
  });

  it("force=file selects the file store", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cli-sel-"));
    try {
      const store = await selectTokenStore({ force: "file", configDir: tmp });
      expect(store.kind).toBe("file");
      await store.save({ apiUrl: "u", token: "t" });
      expect(await store.load()).toEqual({ apiUrl: "u", token: "t" });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
