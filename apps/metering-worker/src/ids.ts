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

export function parseProjectPublicId(value: string): string | null {
  return parsePublicId(value, "prj_");
}

export function parseEnvironmentPublicId(value: string): string | null {
  return parsePublicId(value, "env_");
}

export function generateRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return "req_" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateUsageRecordId(): string {
  return crypto.randomUUID();
}
