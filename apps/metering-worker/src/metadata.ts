/**
 * Bounded metadata validation.
 * Rejects metadata that could accidentally carry secrets.
 */

const MAX_METADATA_KEYS = 20;
const MAX_KEY_LENGTH = 128;
const MAX_VALUE_LENGTH = 1024;
const FORBIDDEN_KEY_PATTERNS = [
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
  /api[_-]?key/i,
  /bearer/i,
  /signing/i,
  /private[_-]?key/i,
];

export function validateMetadata(
  metadata: unknown,
): { ok: true; value: Record<string, unknown> | null } | { ok: false; message: string } {
  if (metadata === null || metadata === undefined) {
    return { ok: true, value: null };
  }

  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return { ok: false, message: "metadata must be an object or null" };
  }

  const obj = metadata as Record<string, unknown>;
  const keys = Object.keys(obj);

  if (keys.length > MAX_METADATA_KEYS) {
    return { ok: false, message: `metadata exceeds ${MAX_METADATA_KEYS} keys` };
  }

  for (const key of keys) {
    if (key.length > MAX_KEY_LENGTH) {
      return { ok: false, message: `metadata key exceeds ${MAX_KEY_LENGTH} chars` };
    }
    for (const pattern of FORBIDDEN_KEY_PATTERNS) {
      if (pattern.test(key)) {
        return { ok: false, message: `metadata key '${key}' matches forbidden pattern` };
      }
    }
    const val = obj[key];
    if (typeof val === "string" && val.length > MAX_VALUE_LENGTH) {
      return { ok: false, message: `metadata value for '${key}' exceeds ${MAX_VALUE_LENGTH} chars` };
    }
  }

  return { ok: true, value: obj };
}
