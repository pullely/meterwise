export function newRequestId(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return `px_${Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** identity-worker reports an API key's org as a UUID (or already public): the public `org_<hex>` form. */
export function publicOrgId(orgId: string): string | null {
  if (/^org_[0-9a-f]{32}$/.test(orgId)) return orgId;
  if (UUID_RE.test(orgId)) return `org_${orgId.replace(/-/g, "").toLowerCase()}`;
  return null;
}

export async function sha256Hex(value: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
