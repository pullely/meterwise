/**
 * Pure helpers for optimistic archive flows (Task 0127 / U11).
 *
 * Dependency-free so the optimistic list mutation + rollback bookkeeping can be
 * unit-tested. Used by the projects and environments lists, which call
 * `projects.archive` / `environments.archive` and remove the row optimistically,
 * rolling back to the captured snapshot on error.
 */

export interface Identified {
  id: string;
}

/** Return a new list with the item matching `id` removed (optimistic remove). */
export function removeById<T extends Identified>(list: ReadonlyArray<T>, id: string): T[] {
  return list.filter((item) => item.id !== id);
}

/** Find an item by id (null when absent). */
export function findById<T extends Identified>(list: ReadonlyArray<T>, id: string): T | null {
  return list.find((item) => item.id === id) ?? null;
}

/**
 * Strict typed-confirm gate for archive. The operator must type the resource's
 * slug/name exactly (surrounding whitespace tolerated for paste ergonomics).
 */
export function confirmArchiveMatches(typed: string, expected: string): boolean {
  if (!expected) return false;
  return typed.trim() === expected;
}
