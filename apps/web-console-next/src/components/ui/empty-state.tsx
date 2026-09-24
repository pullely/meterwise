"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import type { LucideIcon } from "lucide-react";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  primaryAction?: { label: string; onClick?: () => void; href?: string };
  secondaryAction?: { label: string; onClick?: () => void; href?: string };
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, primaryAction, secondaryAction, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center rounded-xl border border-dashed bg-card/50 px-6 py-14",
        className,
      )}
    >
      {Icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon className="h-6 w-6" />
        </div>
      )}
      <h3 className="text-base font-semibold tracking-tight">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      {(primaryAction || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {primaryAction &&
            (primaryAction.href ? (
              <Button asChild>
                <a href={primaryAction.href}>{primaryAction.label}</a>
              </Button>
            ) : (
              <Button onClick={primaryAction.onClick}>{primaryAction.label}</Button>
            ))}
          {secondaryAction &&
            (secondaryAction.href ? (
              <Button asChild variant="outline">
                <a href={secondaryAction.href}>{secondaryAction.label}</a>
              </Button>
            ) : (
              <Button variant="outline" onClick={secondaryAction.onClick}>
                {secondaryAction.label}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
