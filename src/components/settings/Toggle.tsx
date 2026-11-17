"use client";

import type { ReactNode } from "react";
import { cn } from "@/components/ui";

/**
 * A switch with its label and an explanation under it. It is a real checkbox (so a form, a screen reader and the
 * keyboard treat it as one) drawn as a track with a thumb; the whole row is the hit area.
 */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "group flex min-h-11 cursor-pointer items-center justify-between gap-4 text-sm select-none",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-muted">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        className={cn(
          "relative h-6 w-10.5 shrink-0 cursor-pointer appearance-none rounded-full border border-border-strong bg-surface-2 transition-colors duration-200 ease-out",
          "before:absolute before:top-1/2 before:left-0.5 before:size-4.5 before:-translate-y-1/2 before:rounded-full before:bg-white before:shadow-[0_1px_3px_rgb(0_0_0/0.35)] before:transition-transform before:duration-200 before:ease-out before:content-['']",
          "checked:border-transparent checked:bg-accent checked:bg-[image:var(--brand-gradient)] checked:before:translate-x-[18px]",
          "group-active:before:scale-90 focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed",
        )}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
