"use client";

import * as React from "react";
import { Copy, Check } from "lucide-react";
import { Button, type ButtonProps } from "./button";

interface CopyButtonProps extends Omit<ButtonProps, "onClick" | "children" | "loading"> {
  /** Text written to the clipboard. */
  value: string;
  label?: string;
  copiedLabel?: string;
}

/**
 * Copy-to-clipboard button with inline "Copied ✓" feedback (Vercel-style) —
 * swaps the icon to a checkmark and the label for ~1.5s instead of firing a
 * toast. The accessible name updates so screen readers announce the result.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  variant = "outline",
  size = "sm",
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onCopy = React.useCallback(() => {
    void navigator.clipboard?.writeText(value);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, [value]);

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={onCopy}
      aria-label={copied ? copiedLabel : label}
      {...props}
    >
      {copied ? <Check className="text-success" aria-hidden /> : <Copy aria-hidden />}
      {copied ? copiedLabel : label}
    </Button>
  );
}
