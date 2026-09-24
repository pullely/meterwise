/**
 * Pure helpers for the org-scoped audit-log panel.
 *
 * Kept dependency-free (no React, no `next/*`, no DOM) so the filter-query
 * building, "Load more" pagination accumulation, timestamp formatting, and
 * NDJSON export shaping can be unit-tested in isolation. The React wiring lives
 * in the audit page (`app/(app)/orgs/[orgSlug]/audit/page.tsx`); this file owns:
 *
 *   - the filter form → SDK `by:"org"` query builder (`buildAuditQuery`)
 *   - the "Load more" accumulation reducer (`appendAuditPage`)
 *   - the timestamp + actor view-model shapers
 *   - the NDJSON serializer for the in-browser export download
 *
 * Cursor handling mirrors the SDK contract: the continuation cursor is an
 * opaque base64 token surfaced by `EventsClient.listAuditEntriesPage` as
 * `cursor` (sourced from `meta.cursor`, NOT a body field). Callers MUST pass it
 * back verbatim — never construct or parse it. Filters never alter the cursor
 * keyset; they only narrow the eligible rows.
 */

import type { EventActorType, PublicAuditEntry } from "@saas/contracts/events";
import type { ListAuditEntriesQuery } from "@saas/sdk";

/** Raw, unvalidated values straight from the filter form inputs. */
export interface AuditFilterFormValues {
  category: string;
  actorId: string;
  actorType: string;
  subjectKind: string;
  subjectId: string;
  eventType: string;
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilterFormValues = {
  category: "",
  actorId: "",
  actorType: "",
  subjectKind: "",
  subjectId: "",
  eventType: "",
  from: "",
  to: "",
};

/** Trim a form value; treat empty / whitespace-only as "unset". */
function clean(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the discriminated `by:"org"` SDK query from the filter form values.
 * Only non-empty fields are included, so an all-blank form yields the bare
 * `{ by: "org" }` query (every entry). The worker is the authoritative
 * validator; this builder only forwards trimmed, non-empty strings.
 *
 * `cursor` is threaded in for "Load more"; omit it for the first page.
 */
export function buildAuditQuery(
  values: AuditFilterFormValues,
  cursor?: string,
): ListAuditEntriesQuery {
  const category = clean(values.category);
  const actorId = clean(values.actorId);
  const actorType = clean(values.actorType);
  const subjectKind = clean(values.subjectKind);
  const subjectId = clean(values.subjectId);
  const eventType = clean(values.eventType);
  const from = clean(values.from);
  const to = clean(values.to);
  return {
    by: "org",
    ...(category !== undefined ? { category } : {}),
    ...(actorId !== undefined ? { actorId } : {}),
    ...(actorType !== undefined
      ? { actorType: actorType as EventActorType }
      : {}),
    ...(subjectKind !== undefined ? { subjectKind } : {}),
    ...(subjectId !== undefined ? { subjectId } : {}),
    ...(eventType !== undefined ? { eventType } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  } as ListAuditEntriesQuery;
}

/** Whether the form has at least one active filter. */
export function hasActiveAuditFilters(values: AuditFilterFormValues): boolean {
  return (
    clean(values.category) !== undefined ||
    clean(values.actorId) !== undefined ||
    clean(values.actorType) !== undefined ||
    clean(values.subjectKind) !== undefined ||
    clean(values.subjectId) !== undefined ||
    clean(values.eventType) !== undefined ||
    clean(values.from) !== undefined ||
    clean(values.to) !== undefined
  );
}

/**
 * Format an ISO timestamp to a short local date+time, tolerating null and
 * malformed values (returns the supplied fallback rather than "Invalid Date").
 */
export function formatAuditTimestamp(
  value: string | null | undefined,
  fallback = "—",
): string {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString();
}

/** Short `actorType:actorId` label, truncating long opaque ids for display. */
export function formatAuditActor(
  entry: Pick<PublicAuditEntry, "actorType" | "actorId">,
  maxIdChars = 12,
): string {
  const id =
    entry.actorId.length > maxIdChars
      ? entry.actorId.slice(0, maxIdChars)
      : entry.actorId;
  return `${entry.actorType}:${id}`;
}

/** Accumulated state for the cursor-paginated audit list. */
export interface AuditLogState {
  entries: ReadonlyArray<PublicAuditEntry>;
  /** Opaque continuation cursor; null when the last page has been reached. */
  cursor: string | null;
}

export const EMPTY_AUDIT_LOG: AuditLogState = {
  entries: [],
  cursor: null,
};

/**
 * Fold a freshly-fetched page into the accumulated state.
 *
 * `reset` distinguishes the initial / refreshed load (replace the list) from a
 * "Load more" append (concatenate). De-duplication by entry id guards against
 * a boundary entry appearing on two adjacent pages — append is idempotent on id.
 */
export function appendAuditPage(
  prev: AuditLogState,
  page: {
    entries: ReadonlyArray<PublicAuditEntry>;
    cursor: string | null;
  },
  reset = false,
): AuditLogState {
  if (reset) {
    return { entries: page.entries.slice(), cursor: page.cursor };
  }
  const seen = new Set(prev.entries.map((e) => e.id));
  const merged = prev.entries.slice();
  for (const e of page.entries) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      merged.push(e);
    }
  }
  return { entries: merged, cursor: page.cursor };
}

/** Whether a "Load more" affordance should be shown. */
export function hasMoreAudit(state: AuditLogState): boolean {
  return state.cursor !== null;
}

/**
 * Serialize a set of audit entries to an NDJSON string (one JSON document per
 * line, trailing newline). Mirrors the SDK's `exportAuditEntriesNdjson` line
 * shape exactly so a Console download and a CLI export are byte-identical for
 * the same entries. Used by the in-browser "Export NDJSON" Blob download.
 */
export function auditEntriesToNdjson(
  entries: ReadonlyArray<PublicAuditEntry>,
): string {
  if (entries.length === 0) return "";
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Modern timeline view-model helpers (audit UX pass)
// ---------------------------------------------------------------------------

/**
 * Curated category options for the filter select. The API treats category as
 * a free string, so this list is a UX courtesy (one click instead of typing),
 * sourced from the categories the workers actually emit. An unknown category
 * arriving in data renders fine — only the *filter* select is curated.
 */
export const AUDIT_CATEGORY_OPTIONS: ReadonlyArray<string> = [
  "auth",
  "organization",
  "membership",
  "project",
  "billing",
  "subscription",
  "entitlements",
  "config",
  "webhooks",
  "metering",
  "notifications",
  "security",
];

export const AUDIT_ACTOR_TYPE_OPTIONS: ReadonlyArray<EventActorType> = [
  "user",
  "service_principal",
  "workflow",
  "system",
];

/**
 * Visual accent per category — a semantic tone the renderer maps to design
 * tokens, and a lucide icon name resolved by the renderer (same convention as
 * `settings-nav.ts`). Unknown categories get the neutral fallback.
 */
export interface CategoryAccent {
  tone: "violet" | "blue" | "green" | "amber" | "rose" | "slate";
  icon: string;
}

const CATEGORY_ACCENTS: Record<string, CategoryAccent> = {
  auth: { tone: "rose", icon: "KeyRound" },
  security: { tone: "rose", icon: "ShieldCheck" },
  organization: { tone: "violet", icon: "Building2" },
  membership: { tone: "violet", icon: "Users" },
  project: { tone: "blue", icon: "FolderKanban" },
  config: { tone: "blue", icon: "SlidersHorizontal" },
  billing: { tone: "green", icon: "Receipt" },
  subscription: { tone: "green", icon: "Receipt" },
  entitlements: { tone: "amber", icon: "Gauge" },
  metering: { tone: "amber", icon: "Gauge" },
  webhooks: { tone: "blue", icon: "Webhook" },
  notifications: { tone: "violet", icon: "Bell" },
};

export function categoryAccent(category: string): CategoryAccent {
  return CATEGORY_ACCENTS[category] ?? { tone: "slate", icon: "ScrollText" };
}

/**
 * Compact relative time ("just now", "5m ago", "3h ago", "2d ago"); beyond
 * 7 days falls back to a short local date. Malformed input → fallback. The
 * absolute timestamp belongs in a `title` attribute next to this label.
 */
export function formatRelativeTime(
  value: string | null | undefined,
  now: number = Date.now(),
  fallback = "—",
): string {
  if (!value) return fallback;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return fallback;
  const diffSec = Math.max(0, Math.floor((now - t) / 1000));
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export interface AuditDayGroup {
  /** "Today", "Yesterday", or a long local date. */
  label: string;
  /** Local-date key (YYYY-MM-DD) for stable React keys. */
  key: string;
  entries: PublicAuditEntry[];
}

function localDayKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Group entries by local calendar day, preserving input order (the API
 * already returns newest-first). Entries with malformed timestamps fall into
 * a trailing "Unknown date" group rather than being dropped.
 */
export function groupAuditEntriesByDay(
  entries: ReadonlyArray<PublicAuditEntry>,
  now: number = Date.now(),
): AuditDayGroup[] {
  const todayKey = localDayKey(new Date(now));
  const yesterdayKey = localDayKey(new Date(now - 24 * 60 * 60 * 1000));
  const groups: AuditDayGroup[] = [];
  const byKey = new Map<string, AuditDayGroup>();
  for (const e of entries) {
    const d = new Date(e.occurredAt);
    const valid = !Number.isNaN(d.getTime());
    const key = valid ? localDayKey(d) : "unknown";
    let group = byKey.get(key);
    if (!group) {
      const label = !valid
        ? "Unknown date"
        : key === todayKey
          ? "Today"
          : key === yesterdayKey
            ? "Yesterday"
            : d.toLocaleDateString(undefined, {
                weekday: "long",
                month: "long",
                day: "numeric",
                year: "numeric",
              });
      group = { label, key, entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.entries.push(e);
  }
  return groups;
}

/** Time-range presets for the filter toolbar. */
export type AuditTimePreset = "any" | "1h" | "24h" | "7d" | "30d" | "custom";

export const AUDIT_TIME_PRESETS: ReadonlyArray<{
  value: AuditTimePreset;
  label: string;
}> = [
  { value: "any", label: "Any time" },
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom range" },
];

const PRESET_MS: Record<Exclude<AuditTimePreset, "any" | "custom">, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Resolve a non-custom preset to the `from` ISO bound (no `to` — presets are
 * always "until now"). `any`/`custom` return undefined: `custom` keeps the
 * caller's explicit from/to fields authoritative.
 */
export function presetFromIso(
  preset: AuditTimePreset,
  now: number = Date.now(),
): string | undefined {
  if (preset === "any" || preset === "custom") return undefined;
  return new Date(now - PRESET_MS[preset]).toISOString();
}

/** One removable chip per active filter, for the toolbar summary row. */
export interface AuditFilterChip {
  key: keyof AuditFilterFormValues;
  label: string;
}

const CHIP_LABELS: Record<keyof AuditFilterFormValues, string> = {
  category: "category",
  actorId: "actor",
  actorType: "actor type",
  subjectKind: "subject kind",
  subjectId: "subject",
  eventType: "event",
  from: "from",
  to: "to",
};

export function buildAuditFilterChips(
  values: AuditFilterFormValues,
): AuditFilterChip[] {
  const chips: AuditFilterChip[] = [];
  for (const key of Object.keys(CHIP_LABELS) as Array<keyof AuditFilterFormValues>) {
    const v = clean(values[key]);
    if (v !== undefined) chips.push({ key, label: `${CHIP_LABELS[key]}: ${v}` });
  }
  return chips;
}
