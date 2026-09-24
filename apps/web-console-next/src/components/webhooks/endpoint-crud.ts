/**
 * Pure helpers for the webhook-endpoint CRUD flow (Task 0112).
 *
 * Kept dependency-free (no React, no `next/*`, no DOM) so the validation,
 * idempotency-key, and typed-confirm gating can be unit-tested in isolation.
 * The React component wiring lives in:
 *
 *   - create-endpoint-dialog.tsx   (creation form)
 *   - edit-endpoint-dialog.tsx     (rename / re-target / description)
 *   - disable-endpoint-dialog.tsx  (status flip with optional reason)
 *   - delete-endpoint-dialog.tsx   (typed-confirmation destructive)
 *
 * This file owns:
 *   - `validateEndpointUrl`        — URL validation matching the contract
 *   - `nameValidation` / `descriptionValidation` — bounded string rules
 *   - `buildUpdatePatch`           — diff-only PATCH body shape
 *   - `confirmDeleteMatches`       — typed-confirm exact-match gate
 *   - `generateIdempotencyKey`     — UUID-or-fallback per submission
 *
 * Re-enable: the dialog component lives in `enable-endpoint-dialog.tsx`
 * and calls `client.webhooks.enableEndpoint(...)` directly (no PATCH-body
 * shaping needed — the request has no fields). Spec carry-forward:
 * /ai/proposals/task-0112-spec-update.md.
 */

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

export interface UrlValidation {
  ok: boolean;
  message?: string;
}

/**
 * Validate a webhook endpoint URL.
 *
 * Rules (mirror the contract surface — http(s) only, parseable, hostname
 * present). Empty / whitespace-only is considered invalid; the caller is
 * expected to require the field at the form level.
 */
export function validateEndpointUrl(raw: string): UrlValidation {
  const value = (raw ?? "").trim();
  if (!value) return { ok: false, message: "URL is required" };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, message: "Enter a valid URL (https://example.com/hook)" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "URL must use http or https" };
  }
  if (!parsed.hostname) {
    return { ok: false, message: "URL must include a hostname" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Bounded string rules (name, description)
// ---------------------------------------------------------------------------

export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 500;
export const DISABLED_REASON_MAX = 280;

export function validateName(raw: string): UrlValidation {
  const value = (raw ?? "").trim();
  if (value.length === 0) return { ok: true }; // optional
  if (value.length > NAME_MAX)
    return { ok: false, message: `Keep the name under ${NAME_MAX} characters` };
  return { ok: true };
}

export function validateDescription(raw: string): UrlValidation {
  const value = (raw ?? "").trim();
  if (value.length === 0) return { ok: true }; // optional
  if (value.length > DESCRIPTION_MAX)
    return {
      ok: false,
      message: `Keep the description under ${DESCRIPTION_MAX} characters`,
    };
  return { ok: true };
}

export function validateDisabledReason(raw: string): UrlValidation {
  const value = (raw ?? "").trim();
  if (value.length === 0) return { ok: true }; // optional
  if (value.length > DISABLED_REASON_MAX)
    return {
      ok: false,
      message: `Keep the reason under ${DISABLED_REASON_MAX} characters`,
    };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Update-patch builder
// ---------------------------------------------------------------------------

export interface EndpointEditableFields {
  url: string;
  name: string;
  description: string;
}

export interface EndpointSnapshot {
  url: string;
  name: string | null;
  description: string | null;
}

export interface UpdatePatch {
  url?: string;
  name?: string | null;
  description?: string | null;
}

/**
 * Build a minimal PATCH body containing only the fields the operator
 * actually changed. Empty-string `name`/`description` after trim collapse
 * to `null` (clear the field). `url` is never cleared — it's required.
 *
 * Returns `null` when nothing changed; the caller can short-circuit
 * before issuing the network call.
 */
export function buildUpdatePatch(
  current: EndpointSnapshot,
  next: EndpointEditableFields,
): UpdatePatch | null {
  const patch: UpdatePatch = {};

  const trimmedUrl = next.url.trim();
  if (trimmedUrl !== current.url) patch.url = trimmedUrl;

  const nextName = next.name.trim() === "" ? null : next.name.trim();
  if (nextName !== (current.name ?? null)) patch.name = nextName;

  const nextDesc = next.description.trim() === "" ? null : next.description.trim();
  if (nextDesc !== (current.description ?? null)) patch.description = nextDesc;

  if (Object.keys(patch).length === 0) return null;
  return patch;
}

// ---------------------------------------------------------------------------
// Typed-confirm delete gate
// ---------------------------------------------------------------------------

/**
 * Strict exact-match gate for the destructive delete confirm. The operator
 * must type the endpoint URL byte-for-byte; any leading/trailing whitespace
 * is tolerated (paste-from-clipboard ergonomics) but the canonical body
 * must match.
 */
export function confirmDeleteMatches(typed: string, expectedUrl: string): boolean {
  if (!expectedUrl) return false;
  return typed.trim() === expectedUrl;
}

// ---------------------------------------------------------------------------
// Idempotency-Key generator
// ---------------------------------------------------------------------------

/**
 * Generate a fresh idempotency key per create submission. Prefers
 * `crypto.randomUUID` when available (modern browsers + Edge Runtime);
 * falls back to a documented composite ("idem-<timestamp>-<random>") that
 * preserves uniqueness across retries within the same browser session.
 *
 * The fallback is intentionally NOT `Math.random()`-only: it incorporates
 * `Date.now()` so two retries within a single millisecond on the same
 * machine still differ.
 */
export function generateIdempotencyKey(): string {
  const c =
    typeof globalThis !== "undefined"
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `idem-${ts}-${rand}`;
}
