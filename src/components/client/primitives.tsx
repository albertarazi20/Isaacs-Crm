import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../ui";

/*
 * Two small pieces the spec names but ui.tsx does not ship yet. They live here, next to the screens that use
 * them, so the shared primitives file stays untouched.
 */

/**
 * A filter chip: a pill with an optional count. Active reads as ink-on-paper (`bg-text text-bg`), or as the
 * accent tint when `tone="accent"` (a chosen value rather than a view). 40px tall on a phone, 32px on a desktop.
 */
export function Chip({
  active = false,
  tone = "ink",
  count,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  tone?: "ink" | "accent";
  count?: number | string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium whitespace-nowrap transition select-none disabled:cursor-not-allowed disabled:opacity-50 sm:h-8 sm:text-[13px]",
        active
          ? tone === "accent"
            ? "border-accent/40 bg-accent-soft text-accent"
            : "border-text bg-text text-bg"
          : "border-border bg-surface text-text-2 hover:border-border-strong hover:bg-surface-3 hover:text-text",
        className,
      )}
      {...rest}
    >
      {children}
      {count !== undefined ? (
        <span className={cn("text-xs tabular-nums", active ? "opacity-70" : "text-muted")}>
          {count}
        </span>
      ) : null}
    </button>
  );
}

/** A square ghost button that holds one icon; the aria-label says what it does. 40px on a phone, 32px on a desktop. */
export function IconButton({
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-text active:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 sm:size-8",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * The page's second-rank solid button: ink on paper. The brand gradient is kept for the one action that finishes the
 * page (Hand off), so saving a note or a date uses this.
 */
export function inkButtonClass(extra?: string): string {
  return cn(
    "inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-text px-4 text-sm font-semibold whitespace-nowrap text-bg transition duration-150 ease-out select-none hover:opacity-90 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 sm:h-9",
    extra,
  );
}

/** A small caps label inside a panel, over a group of controls. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("eyebrow", className)}>{children}</p>;
}

/** A status dot in a tone's ink. */
export function Dot({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full bg-current", className)} />
  );
}
