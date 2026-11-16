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

/** The one-line page header: title, context under it, actions right. */
export function PageHeader({
  title,
  context,
  actions,
  className,
}: {
  title: ReactNode;
  context?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {context ? <p className="mt-0.5 text-sm text-muted">{context}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
