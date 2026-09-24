/**
 * Pure helpers for the account profile surface (Task 0127 / U11).
 *
 * Dependency-free so display-name validation/normalization can be unit-tested.
 * React wiring lives in `app/(app)/account/page.tsx`; wire I/O goes through
 * `@saas/sdk` (`auth.getProfile` / `updateProfile` / `logout`).
 */

import type { UpdateProfileRequest } from "@saas/contracts/auth";

export const DISPLAY_NAME_MAX = 80;

export interface FieldValidation {
  ok: boolean;
  message?: string;
}

/**
 * Validate a display name. Empty is allowed (clears the name → null). Bounded
 * length; the worker is the authoritative validator.
 */
export function validateDisplayName(raw: string): FieldValidation {
  const value = (raw ?? "").trim();
  if (value.length > DISPLAY_NAME_MAX) {
    return { ok: false, message: `Keep it under ${DISPLAY_NAME_MAX} characters` };
  }
  return { ok: true };
}

/** Normalize a form display name to the request shape (empty → null clear). */
export function toDisplayNameValue(raw: string): string | null {
  const value = (raw ?? "").trim();
  return value.length === 0 ? null : value;
}

/**
 * Build the PATCH body for a profile update, or `null` when nothing changed
 * (so the caller can short-circuit the network call). `current` is the stored
 * displayName (may be null).
 */
export function buildProfilePatch(
  current: string | null,
  nextRaw: string,
): UpdateProfileRequest | null {
  const next = toDisplayNameValue(nextRaw);
  if (next === (current ?? null)) return null;
  return { displayName: next };
}

/**
 * A short avatar seed (initials) from a display name or email local-part.
 * Tolerates a missing/empty email (some accounts have none) without throwing.
 */
export function initials(displayName: string | null, email: string | null | undefined): string {
  const safeEmail = (email ?? "").trim();
  const source = (displayName && displayName.trim()) || safeEmail.split("@")[0] || safeEmail;
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}
