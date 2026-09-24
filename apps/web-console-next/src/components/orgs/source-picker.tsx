"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import {
  Check,
  FilePlus2,
  Github,
  Gitlab,
  LayoutTemplate,
  Sparkles,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import {
  GIT_PROVIDERS,
  TEMPLATES,
  type GitProviderId,
  type SourceChoice,
} from "./create-org-model";

type IconComponent = React.ComponentType<{ className?: string }>;

const PROVIDER_ICONS: Record<GitProviderId, IconComponent> = {
  github: Github,
  gitlab: Gitlab,
  bitbucket: BitbucketIcon,
};

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  "web-app": LayoutTemplate,
  "api-service": SquareTerminal,
  worker: Workflow,
  "ai-chatbot": Sparkles,
};

export function SourcePicker({
  value,
  onChange,
}: {
  value: SourceChoice;
  onChange: (choice: SourceChoice) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Starting point" className="space-y-6">
      <SelectableRow
        selected={value.kind === "scratch"}
        onClick={() => onChange({ kind: "scratch" })}
        icon={FilePlus2}
        title="Start from scratch"
        description="An empty organization — add projects and environments yourself."
      />

      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Import Git repository
        </div>
        <div className="mt-2 space-y-2">
          {GIT_PROVIDERS.map((p) => (
            <SelectableRow
              key={p.id}
              selected={value.kind === "git" && value.provider === p.id}
              disabled={!p.available}
              badge={p.available ? undefined : "Coming soon"}
              icon={PROVIDER_ICONS[p.id]}
              title={p.name}
              description={p.note}
              onClick={() => onChange({ kind: "git", provider: p.id })}
            />
          ))}
        </div>
      </div>

      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Clone a template
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {TEMPLATES.map((t) => (
            <SelectableRow
              key={t.id}
              selected={value.kind === "template" && value.templateId === t.id}
              disabled
              badge="Coming soon"
              icon={TEMPLATE_ICONS[t.id] ?? LayoutTemplate}
              title={t.name}
              description={t.description}
              onClick={() => onChange({ kind: "template", templateId: t.id })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function SelectableRow({
  selected,
  disabled,
  onClick,
  icon: Icon,
  title,
  description,
  badge,
}: {
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: IconComponent;
  title: string;
  description: string;
  badge?: string | undefined;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border bg-card p-4 text-left transition-colors",
        selected ? "border-primary ring-1 ring-primary" : "border-border",
        disabled ? "cursor-not-allowed opacity-60" : !selected && "hover:border-foreground/30",
      )}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border bg-muted/60">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {title}
          {badge ? <Badge variant="secondary">{badge}</Badge> : null}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      <span
        className={cn(
          "mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors",
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border text-transparent",
        )}
        aria-hidden
      >
        <Check className="h-3 w-3" />
      </span>
    </button>
  );
}

/** Bitbucket has no lucide icon; minimal brand-shaped mark, currentColor. */
function BitbucketIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M2.65 3a.65.65 0 0 0-.64.76l2.72 16.55c.07.42.43.72.85.72h12.9c.31 0 .58-.23.63-.54l2.88-16.73A.65.65 0 0 0 21.35 3H2.65Zm11.55 11.97H9.85L8.5 8.97h6.9l-1.2 6Z" />
    </svg>
  );
}
