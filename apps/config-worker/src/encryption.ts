/**
 * Encryption adapter for config-worker secret payloads.
 *
 * Uses Web Crypto AES-256-GCM (authenticated encryption) with a random 12-byte IV
 * per value. The encryption key is sourced from an environment binding (SECRET_ENCRYPTION_KEY)
 * and must be a 64-character hex string representing 32 bytes (256 bits).
 *
 * The stored envelope is a JSON-encoded structure containing algorithm metadata,
 * nonce, and ciphertext — never plaintext.
 */

// ── Envelope format ──────────────────────────────────────────

export interface CiphertextEnvelope {
  /** Algorithm identifier for future migration */
  alg: "AES-256-GCM";
  /** Envelope format version */
  v: 1;
  /** Base64-encoded 12-byte IV/nonce */
  iv: string;
  /** Base64-encoded ciphertext (includes GCM auth tag) */
  ct: string;
}

// ── Encryption adapter interface ─────────────────────────────

export interface EncryptionAdapter {
  encrypt(plaintext: string): Promise<CiphertextEnvelope>;
}

// ── Helpers ──────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

const HEX_RE = /^[0-9a-fA-F]{64}$/;

// ── Factory ─────────────────────────────────────────────────

/**
 * Create an encryption adapter from a hex-encoded 256-bit key.
 *
 * @param keyHex 64-character hex string (32 bytes = 256 bits)
 * @returns EncryptionAdapter or null if key is invalid/missing
 */
export async function createEncryptionAdapter(keyHex: string | undefined): Promise<EncryptionAdapter | null> {
  if (!keyHex || !HEX_RE.test(keyHex)) {
    return null;
  }

  const keyBytes = hexToBytes(keyHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );

  return {
    async encrypt(plaintext: string): Promise<CiphertextEnvelope> {
      const iv = new Uint8Array(12);
      crypto.getRandomValues(iv);

      const encoded = new TextEncoder().encode(plaintext);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        encoded,
      );

      return {
        alg: "AES-256-GCM",
        v: 1,
        iv: bytesToBase64(iv),
        ct: bytesToBase64(new Uint8Array(ciphertext)),
      };
    },
  };
}
