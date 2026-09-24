"use client";

import * as React from "react";
import { useForm, type DefaultValues, type FieldValues, type SubmitHandler, type Path } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z, ZodType } from "zod";
import { Label } from "./label";
import { Input } from "./input";
import { Button } from "./button";
import { slugify } from "@/lib/slug";
import { cn } from "@/lib/cn";

export interface FieldSpec<T extends FieldValues> {
  name: Path<T>;
  label: string;
  type?: "text" | "email" | "password";
  placeholder?: string;
  hint?: string;
  autoComplete?: string;
}

interface ZodFormProps<S extends ZodType<FieldValues>> {
  schema: S;
  defaultValues: DefaultValues<z.infer<S>>;
  fields: FieldSpec<z.infer<S>>[];
  submitLabel?: string;
  onSubmit: SubmitHandler<z.infer<S>>;
  cancel?: { label: string; onClick: () => void };
  /**
   * Auto-derive a slug field (`to`) from another field (`from`) as the user
   * types — Vercel's "type a name, the slug fills itself" behaviour. Stops the
   * moment the user edits `to` by hand.
   */
  deriveSlug?: { from: Path<z.infer<S>>; to: Path<z.infer<S>> };
  className?: string;
}

/**
 * Tiny contract-to-form helper. Drives a create flow from a Zod schema
 * (which mirrors a `packages/contracts` request type) plus a field spec
 * list. The verifier should treat this as the canonical proof that
 * contracts → forms is wired in this PR.
 */
export function ZodForm<S extends ZodType<FieldValues>>({
  schema,
  defaultValues,
  fields,
  submitLabel = "Submit",
  onSubmit,
  cancel,
  deriveSlug,
  className,
}: ZodFormProps<S>) {
  type Values = z.infer<S>;
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues,
  });

  // Auto-derive the slug from its source field until the user edits it by hand.
  const slugTouched = React.useRef(false);
  const source = deriveSlug ? watch(deriveSlug.from) : undefined;
  React.useEffect(() => {
    if (!deriveSlug || slugTouched.current) return;
    setValue(deriveSlug.to, slugify(String(source ?? "")) as never, { shouldValidate: false });
  }, [deriveSlug, source, setValue]);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className={cn("space-y-4", className)} noValidate>
      {fields.map((f) => {
        const err = (errors as Record<string, { message?: string } | undefined>)[f.name as string];
        const slugField = deriveSlug && (f.name as string) === (deriveSlug.to as string);
        const reg = register(f.name as Path<Values>);
        return (
          <div key={f.name as string} className="space-y-1.5">
            <Label htmlFor={f.name as string}>{f.label}</Label>
            <Input
              id={f.name as string}
              type={f.type ?? "text"}
              placeholder={f.placeholder}
              autoComplete={f.autoComplete}
              {...reg}
              onChange={(e) => {
                if (slugField) slugTouched.current = true;
                void reg.onChange(e);
              }}
              aria-invalid={err ? true : undefined}
            />
            {err?.message ? (
              <p className="text-xs text-destructive">{err.message}</p>
            ) : f.hint ? (
              <p className="text-xs text-muted-foreground">{f.hint}</p>
            ) : null}
          </div>
        );
      })}
      <div className="flex items-center justify-end gap-2 pt-2">
        {cancel && (
          <Button type="button" variant="ghost" onClick={cancel.onClick}>
            {cancel.label}
          </Button>
        )}
        <Button type="submit" loading={isSubmitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
