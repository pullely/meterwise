"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import {
  Bell,
  Building2,
  ChevronDown,
  Download,
  FolderKanban,
  Gauge,
  KeyRound,
  Receipt,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PublicAuditEntry } from "@saas/contracts/events";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import {
  appendAuditPage,
  AUDIT_ACTOR_TYPE_OPTIONS,
  AUDIT_CATEGORY_OPTIONS,
  AUDIT_TIME_PRESETS,
  buildAuditFilterChips,
  buildAuditQuery,
  categoryAccent,
  EMPTY_AUDIT_LOG,
  formatRelativeTime,
  groupAuditEntriesByDay,
  hasActiveAuditFilters,
  hasMoreAudit,
  presetFromIso,
  type AuditFilterFormValues,
  type AuditLogState,
  type AuditTimePreset,
  type CategoryAccent,
} from "@/components/audit/audit-log";

const ACCENT_ICONS: Record<string, LucideIcon> = {
  KeyRound,
  ShieldCheck,
  Building2,
  Users,
  FolderKanban,
  SlidersHorizontal,
  Receipt,
  Gauge,
  Webhook,
  Bell,
  ScrollText,
};

const TONE_CLASSES: Record<CategoryAccent["tone"], string> = {
  violet: "bg-violet-500/10 text-violet-500",
  blue: "bg-sky-500/10 text-sky-500",
  green: "bg-emerald-500/10 text-emerald-500",
  amber: "bg-amber-500/10 text-amber-500",
  rose: "bg-rose-500/10 text-rose-500",
  slate: "bg-muted text-muted-foreground",
};

/** Debounce a fast-changing text value before it drives refetches. */
function useDebounced<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** datetime-local value → ISO Z (empty/invalid → empty string). */
function localToIso(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export default function AuditPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();

  // Toolbar filter state. Selects apply instantly; text inputs are debounced.
  const [category, setCategory] = React.useState("all");
  const [actorType, setActorType] = React.useState("all");
  const [preset, setPreset] = React.useState<AuditTimePreset>("any");
  const [customFrom, setCustomFrom] = React.useState("");
  const [customTo, setCustomTo] = React.useState("");
  const [eventTypeInput, setEventTypeInput] = React.useState("");
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [actorIdInput, setActorIdInput] = React.useState("");
  const [subjectKindInput, setSubjectKindInput] = React.useState("");
  const [subjectIdInput, setSubjectIdInput] = React.useState("");
  // Bumped by Refresh; re-anchors relative presets ("last hour") to now.
  const [refreshNonce, setRefreshNonce] = React.useState(0);

  const eventType = useDebounced(eventTypeInput);
  const actorId = useDebounced(actorIdInput);
  const subjectKind = useDebounced(subjectKindInput);
  const subjectId = useDebounced(subjectIdInput);

  const applied: AuditFilterFormValues = React.useMemo(
    () => ({
      category: category === "all" ? "" : category,
      actorType: actorType === "all" ? "" : actorType,
      eventType: eventType.trim(),
      actorId: actorId.trim(),
      subjectKind: subjectKind.trim(),
      subjectId: subjectId.trim(),
      from: preset === "custom" ? localToIso(customFrom) : (presetFromIso(preset) ?? ""),
      to: preset === "custom" ? localToIso(customTo) : "",
    }),
    // refreshNonce intentionally re-derives `from` for relative presets.
    [category, actorType, eventType, actorId, subjectKind, subjectId, preset, customFrom, customTo, refreshNonce],
  );
  const appliedKey = JSON.stringify(applied);

  const [log, setLog] = React.useState<AuditLogState>(EMPTY_AUDIT_LOG);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const loadFirstPage = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await wrap(() => client.events.listAuditEntriesPage(orgId, buildAuditQuery(applied)));
    if (res.ok) {
      setLog(appendAuditPage(EMPTY_AUDIT_LOG, res.data, /* reset */ true));
    } else {
      setError({ code: res.error.code, message: res.error.message });
      setLog(EMPTY_AUDIT_LOG);
    }
    setLoading(false);
  }, [client, orgId, appliedKey]);

  React.useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = React.useCallback(async () => {
    if (log.cursor === null || loadingMore) return;
    setLoadingMore(true);
    const res = await wrap(() =>
      client.events.listAuditEntriesPage(orgId, buildAuditQuery(applied, log.cursor ?? undefined)),
    );
    if (res.ok) setLog((prev) => appendAuditPage(prev, res.data));
    else setError({ code: res.error.code, message: res.error.message });
    setLoadingMore(false);
  }, [client, orgId, appliedKey, log.cursor, loadingMore]);

  // Auto-load the next page when the sentinel scrolls into view; the button
  // stays as the keyboard/AT-reachable fallback.
  const sentinelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const node = sentinelRef.current;
    if (!node || log.cursor === null) return;
    const io = new IntersectionObserver(
      (io_entries) => {
        if (io_entries.some((x) => x.isIntersecting)) void loadMore();
      },
      { rootMargin: "240px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [loadMore, log.cursor]);

  const exportNdjson = React.useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const lines: string[] = [];
      for await (const line of client.events.exportAuditEntriesNdjson(orgId, buildAuditQuery(applied))) {
        lines.push(line);
      }
      const blob = new Blob(lines.length > 0 ? lines : [""], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-${orgId}-${Date.now()}.ndjson`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError({ code: "export_failed", message: e instanceof Error ? e.message : "export failed" });
    } finally {
      setExporting(false);
    }
  }, [client, orgId, appliedKey]);

  const chips = buildAuditFilterChips(applied);
  const filtersActive = hasActiveAuditFilters(applied);

  const clearChip = (key: keyof AuditFilterFormValues) => {
    switch (key) {
      case "category":
        setCategory("all");
        break;
      case "actorType":
        setActorType("all");
        break;
      case "eventType":
        setEventTypeInput("");
        break;
      case "actorId":
        setActorIdInput("");
        break;
      case "subjectKind":
        setSubjectKindInput("");
        break;
      case "subjectId":
        setSubjectIdInput("");
        break;
      case "from":
      case "to":
        setPreset("any");
        setCustomFrom("");
        setCustomTo("");
        break;
    }
  };

  const clearAll = () => {
    setCategory("all");
    setActorType("all");
    setPreset("any");
    setCustomFrom("");
    setCustomTo("");
    setEventTypeInput("");
    setActorIdInput("");
    setSubjectKindInput("");
    setSubjectIdInput("");
  };

  const groups = groupAuditEntriesByDay(log.entries);

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
          <p className="text-sm text-muted-foreground">
            Immutable record of everything that happened in this organization.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Refresh"
            onClick={() => setRefreshNonce((n) => n + 1)}
            disabled={loading}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          <Button type="button" variant="outline" onClick={() => void exportNdjson()} loading={exporting} disabled={loading}>
            <Download className="mr-2 h-4 w-4" />
            Export NDJSON
          </Button>
        </div>
      </header>

      {/* Filter toolbar — selects apply instantly, text inputs debounce. */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-8 w-[160px] text-xs" aria-label="Category">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {AUDIT_CATEGORY_OPTIONS.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={actorType} onValueChange={setActorType}>
            <SelectTrigger className="h-8 w-[160px] text-xs" aria-label="Actor type">
              <SelectValue placeholder="Actor type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actors</SelectItem>
              {AUDIT_ACTOR_TYPE_OPTIONS.map((t) => (
                <SelectItem key={t} value={t}>
                  {t.replace("_", " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={preset} onValueChange={(v) => setPreset(v as AuditTimePreset)}>
            <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Time range">
              <SelectValue placeholder="Time range" />
            </SelectTrigger>
            <SelectContent>
              {AUDIT_TIME_PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            value={eventTypeInput}
            onChange={(e) => setEventTypeInput(e.target.value)}
            placeholder="Filter by event type (member.role_changed)"
            aria-label="Event type"
            className="h-8 w-[260px] text-xs"
          />

          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={advancedOpen}
          >
            Advanced
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", advancedOpen && "rotate-180")} />
          </button>
        </div>

        {preset === "custom" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="datetime-local"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              aria-label="From"
              className="h-8 w-[210px] text-xs"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="datetime-local"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              aria-label="To"
              className="h-8 w-[210px] text-xs"
            />
          </div>
        ) : null}

        {advancedOpen ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={actorIdInput}
              onChange={(e) => setActorIdInput(e.target.value)}
              placeholder="Actor ID (usr_… / svc_…)"
              aria-label="Actor ID"
              className="h-8 w-[220px] text-xs"
            />
            <Input
              value={subjectKindInput}
              onChange={(e) => setSubjectKindInput(e.target.value)}
              placeholder="Subject kind (project, member…)"
              aria-label="Subject kind"
              className="h-8 w-[220px] text-xs"
            />
            <Input
              value={subjectIdInput}
              onChange={(e) => setSubjectIdInput(e.target.value)}
              placeholder="Subject ID (prj_… / mem_…)"
              aria-label="Subject ID"
              className="h-8 w-[220px] text-xs"
            />
          </div>
        ) : null}

        {chips.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => clearChip(chip.key)}
                className="group inline-flex max-w-[280px] items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2.5 pr-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                aria-label={`Remove filter ${chip.label}`}
              >
                <span className="truncate">{chip.label}</span>
                <X className="h-3 w-3 opacity-60 group-hover:opacity-100" />
              </button>
            ))}
            <button
              type="button"
              onClick={clearAll}
              className="text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              Clear all
            </button>
          </div>
        ) : null}
      </div>

      {loading ? (
        <Card>
          <CardContent className="space-y-2 pt-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{error.code}</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : log.entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No matching activity"
          description={
            filtersActive
              ? "No events match the current filters. Widen the time range or clear a filter."
              : "Activity in this org will surface here as events are recorded."
          }
          {...(filtersActive ? { primaryAction: { label: "Clear filters", onClick: clearAll } } : {})}
        />
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.label}
              </h2>
              <Card className="divide-y divide-border p-0">
                {group.entries.map((e) => (
                  <AuditRow
                    key={e.id}
                    entry={e}
                    expanded={expandedId === e.id}
                    onToggle={() => setExpandedId((cur) => (cur === e.id ? null : e.id))}
                    onFilterEventType={() => setEventTypeInput(e.eventType)}
                    onFilterActor={() => {
                      setAdvancedOpen(true);
                      setActorIdInput(e.actorId);
                    }}
                  />
                ))}
              </Card>
            </section>
          ))}

          {hasMoreAudit(log) ? (
            <div ref={sentinelRef} className="flex justify-center pt-1">
              <Button type="button" variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
                Load more
              </Button>
            </div>
          ) : (
            <p className="pt-1 text-center text-[11px] text-muted-foreground">End of audit history for these filters.</p>
          )}
        </div>
      )}
    </div>
  );
}

function AuditRow({
  entry,
  expanded,
  onToggle,
  onFilterEventType,
  onFilterActor,
}: {
  entry: PublicAuditEntry;
  expanded: boolean;
  onToggle: () => void;
  onFilterEventType: () => void;
  onFilterActor: () => void;
}) {
  const accent = categoryAccent(entry.category);
  const Icon = ACCENT_ICONS[accent.icon] ?? ScrollText;
  const absolute = new Date(entry.occurredAt).toLocaleString();

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
      >
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
            TONE_CLASSES[accent.tone],
          )}
          aria-hidden
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{entry.description}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="font-mono">{entry.eventType}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">
              {entry.actorType}:{entry.actorId.length > 16 ? `${entry.actorId.slice(0, 16)}…` : entry.actorId}
            </span>
            {entry.subject.name ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{entry.subject.name}</span>
              </>
            ) : null}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 pt-0.5">
          <Badge variant="secondary" className="hidden text-[10px] sm:inline-flex">
            {entry.category}
          </Badge>
          <time className="whitespace-nowrap text-[11px] text-muted-foreground" title={absolute} dateTime={entry.occurredAt}>
            {formatRelativeTime(entry.occurredAt)}
          </time>
          <ChevronDown
            className={cn("h-3.5 w-3.5 text-muted-foreground/60 transition-transform", expanded && "rotate-180")}
            aria-hidden
          />
        </span>
      </button>

      {expanded ? (
        <div className="space-y-3 border-t border-dashed bg-muted/30 px-4 py-3">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
            <DetailPair label="Occurred" value={absolute} />
            <DetailPair label="Subject" value={`${entry.subject.kind}:${entry.subject.id}`} mono copyValue={entry.subject.id} />
            <DetailPair label="Actor" value={`${entry.actorType}:${entry.actorId}`} mono copyValue={entry.actorId} />
            <DetailPair label="Source" value={entry.source} mono />
            <DetailPair label="Request" value={entry.requestId} mono copyValue={entry.requestId} />
            {entry.correlationId ? (
              <DetailPair label="Correlation" value={entry.correlationId} mono copyValue={entry.correlationId} />
            ) : null}
          </dl>

          {Object.keys(entry.payload).length > 0 ? (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Payload</span>
                <CopyButton value={JSON.stringify(entry.payload, null, 2)} variant="ghost" size="sm" />
              </div>
              <pre className="max-h-64 overflow-auto rounded-md border bg-background p-3 font-mono text-[11px] leading-relaxed">
                {JSON.stringify(entry.payload, null, 2)}
              </pre>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={onFilterEventType}>
              Filter: this event type
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onFilterActor}>
              Filter: this actor
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DetailPair({
  label,
  value,
  mono = false,
  copyValue,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyValue?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono")} title={value}>
        {value}
      </dd>
      {copyValue ? <CopyButton value={copyValue} variant="ghost" size="sm" className="h-5 w-5 shrink-0 p-0" /> : null}
    </div>
  );
}
