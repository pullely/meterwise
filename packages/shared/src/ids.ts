// Generic ID utilities — no domain knowledge

/**
 * Generates a simple random ID string. In production, use a CUID2 or ULID library.
 * This is a placeholder implementation for local development only.
 */
export function generateId(prefix?: string): string {
  const rand = Math.random().toString(36).slice(2, 11);
  return prefix ? `${prefix}_${rand}` : rand;
}

export function isValidId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0;
}
