"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Vercel-style settings card: a bordered surface with a titled body and a
 * separated footer bar that carries a hint on the left and an action (e.g.
 * Save / Copy) on the right. This is the canonical "settings section" shape used
 * across modern SaaS consoles, adapted to our palette.
 */
export interface SettingsCardProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Card body — typically an input, form, table, or read-only field. */
  children?: React.ReactNode;
  /** Left-aligned helper text in the footer bar. */
  footerHint?: React.ReactNode;
  /** Right-aligned footer control(s), e.g. a Save or Copy button. */
  footerAction?: React.ReactNode;
  /** `danger` paints the destructive variant (red border + footer). */
  tone?: "default" | "danger";
  className?: string;
}

export function SettingsCard({
  title,
  description,
  children,
  footerHint,
  footerAction,
  tone = "default",
  className,
}: SettingsCardProps) {
  const danger = tone === "danger";
  const hasFooter = footerHint != null || footerAction != null;

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border bg-card shadow-sm",
        danger && "border-destructive/40",
        className,
      )}
    >
      <div className="space-y-4 p-6">
        <div className="space-y-1.5">
          <h2
            className={cn(
              "text-xl font-semibold tracking-tight",
              danger && "text-destructive",
            )}
          >
            {title}
          </h2>
          {description != null && (
            <div className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        {children}
      </div>

      {hasFooter && (
        <div
          className={cn(
            "flex flex-col gap-3 border-t px-6 py-3 sm:flex-row sm:items-center sm:justify-between",
            danger ? "border-destructive/30 bg-destructive/5" : "bg-muted/40",
          )}
        >
          <div className="text-[13px] text-muted-foreground">{footerHint}</div>
          {footerAction != null && (
            <div className="flex shrink-0 items-center justify-end gap-2">{footerAction}</div>
          )}
        </div>
      )}
    </section>
  );
}
