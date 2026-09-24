"use client";

import * as React from "react";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { planFeatureLines } from "@/components/billing/plan-actions";
import { PLAN_OPTIONS } from "./create-org-model";

export function PlanPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Plan" className="grid gap-4 sm:grid-cols-2">
      {PLAN_OPTIONS.map((p) => {
        const selected = p.code === value;
        return (
          <button
            key={p.code}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(p.code)}
            className={cn(
              "relative flex flex-col rounded-lg border bg-card p-5 text-left transition-all",
              selected
                ? "border-primary shadow-sm ring-1 ring-primary"
                : "border-border hover:border-foreground/30",
            )}
          >
            <span
              className={cn(
                "absolute right-4 top-4 grid h-5 w-5 place-items-center rounded-full border transition-colors",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-transparent",
              )}
              aria-hidden
            >
              <Check className="h-3 w-3" />
            </span>
            <div className="flex items-center gap-2 pr-8">
              <span className="font-semibold">{p.name}</span>
              {p.popular ? <Badge variant="success">Popular</Badge> : null}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{p.tagline}</p>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-2xl font-semibold tracking-tight">{p.price}</span>
              {p.per ? <span className="text-sm text-muted-foreground">{p.per}</span> : null}
            </div>
            <ul className="mt-4 space-y-1.5">
              {planFeatureLines(p.code).map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  {f}
                </li>
              ))}
            </ul>
          </button>
        );
      })}
    </div>
  );
}
