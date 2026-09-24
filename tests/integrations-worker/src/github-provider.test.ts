import { createGithubProvider } from "@integrations-worker/providers/github";
import { mintAppJwt } from "@integrations-worker/github-app";
import type { ProviderCredentials } from "@integrations-worker/providers/types";

const WEBHOOK_SECRET = "wh-secret";

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function toPem(der: ArrayBuffer): string {
  const b64 = bytesToBase64(new Uint8Array(der));
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

async function generateTestKeyPem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  return { pem: toPem(der), publicKey: pair.publicKey };
}

function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const bytes = new Uint8Array(sig);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
}

function credentials(pem = "irrelevant"): ProviderCredentials {
  return { appId: "4242", appSlug: "sourceplane-stage", privateKeyPem: pem, webhookSecret: WEBHOOK_SECRET };
}

describe("GitHub provider adapter", () => {
  it("builds the App install URL with the signed state attached", () => {
    const provider = createGithubProvider(credentials());
    const url = new URL(provider.buildInstallUrl({ state: "abc.def" }));
    expect(url.origin + url.pathname).toBe(
      "https://github.com/apps/sourceplane-stage/installations/new",
    );
    expect(url.searchParams.get("state")).toBe("abc.def");
  });

  it("accepts a correctly signed inbound payload and rejects everything else", async () => {
    const provider = createGithubProvider(credentials());
    const body = JSON.stringify({ action: "opened" });
    const raw = new TextEncoder().encode(body).buffer as ArrayBuffer;
    const goodSig = `sha256=${await hmacHex(WEBHOOK_SECRET, body)}`;

    expect(await provider.verifyInboundSignature(raw, goodSig)).toBe(true);
    expect(await provider.verifyInboundSignature(raw, goodSig.toUpperCase())).toBe(false);
    expect(await provider.verifyInboundSignature(raw, null)).toBe(false);
    expect(await provider.verifyInboundSignature(raw, "sha256=deadbeef")).toBe(false);
    expect(
      await provider.verifyInboundSignature(raw, `sha256=${await hmacHex("wrong", body)}`),
    ).toBe(false);
    expect(await provider.verifyInboundSignature(raw, goodSig.replace("sha256=", "sha1="))).toBe(
      false,
    );
  });

  it("completeConnect fetches installation facts as the App", async () => {
    const { pem } = await generateTestKeyPem();
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url: input, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return Promise.resolve(
        Response.json({
          id: 9912345,
          account: { login: "acme", id: 42, type: "Organization" },
          repository_selection: "selected",
          permissions: { contents: "read" },
          events: ["push"],
          suspended_at: null,
        }),
      );
    };
    const provider = createGithubProvider(credentials(pem), fetchImpl);
    const facts = await provider.completeConnect({ installationId: 9912345, nowMs: Date.now() });
    expect(facts).not.toBeNull();
    expect(facts!.installationId).toBe(9912345);
    expect(facts!.accountLogin).toBe("acme");
    expect(calls[0]!.url).toBe("https://api.github.com/app/installations/9912345");
    expect(calls[0]!.headers.authorization).toMatch(/^Bearer eyJ/);
    expect(calls[0]!.headers["user-agent"]).toBe("meterwise-integrations-worker");
  }, 30_000);

  it("completeConnect fails closed on a malformed private key", async () => {
    const provider = createGithubProvider(credentials("-----BEGIN RSA PRIVATE KEY-----\nnotakey\n-----END RSA PRIVATE KEY-----"));
    const facts = await provider.completeConnect({ installationId: 1, nowMs: Date.now() });
    expect(facts).toBeNull();
  });
});

describe("App JWT minting", () => {
  it("mints a verifiable RS256 JWT with App claims", async () => {
    const { pem, publicKey } = await generateTestKeyPem();
    const nowMs = 1_750_000_000_000;
    const jwt = await mintAppJwt("4242", pem, nowMs);
    expect(jwt).not.toBeNull();

    const [h, p, s] = jwt!.split(".") as [string, string, string];
    const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(h)));
    const claims = JSON.parse(new TextDecoder().decode(base64urlToBytes(p)));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(claims.iss).toBe("4242");
    expect(claims.iat).toBe(Math.floor(nowMs / 1000) - 60);
    expect(claims.exp).toBe(Math.floor(nowMs / 1000) + 540);

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      base64urlToBytes(s).buffer as ArrayBuffer,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(valid).toBe(true);
  }, 30_000);

  it("returns null for unusable PEM input", async () => {
    expect(await mintAppJwt("1", "", Date.now())).toBeNull();
    expect(await mintAppJwt("1", "not a pem at all", Date.now())).toBeNull();
  });
});
