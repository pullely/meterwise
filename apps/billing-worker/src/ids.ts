const UUID_HEX_RE = /^[0-9a-f]{32}$/;

function parsePublicId(value: string, prefix: string): string | null {
  if (!value.startsWith(prefix)) return null;
  const hex = value.slice(prefix.length);
  if (!UUID_HEX_RE.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseOrgPublicId(value: string): string | null {
  return parsePublicId(value, "org_");
}

/** Inverse of parseOrgPublicId: hex UUID → public org id (`org_<32-hex>`). */
export function orgPublicId(hexUuid: string): string {
  return "org_" + hexUuid.replace(/-/g, "");
}

export function parseSubscriptionPublicId(value: string): string | null {
  return parsePublicId(value, "sub_");
}

export function generateRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return "req_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// RFC-4122 v4 UUID from getRandomValues. Used for entitlement-decision
// observation primary keys. crypto.randomUUID may be unavailable in some
// Workers contexts, so we hand-roll for determinism via injectable deps in tests.
export function generateUuid(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  buf[6] = (buf[6]! & 0x0f) | 0x40;
  buf[8] = (buf[8]! & 0x3f) | 0x80;
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i]!.toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
