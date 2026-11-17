import Link from "next/link";
import type { ReactNode } from "react";
import { Card, cn } from "@/components/ui";

/*
 * Page-level pieces the Settings screens share. Server-safe (no hooks), so a
 * server page and a client panel can both use them. Candidates for ui.tsx once the whole app has settled.
 */

/** A number with its label over it, the dashboard's KPI tile. */
export function StatTile({
  label,
  value,
  sub,
  tone,
  className,
}: {
  label: string;
  value: string | number;
  sub?: ReactNode;
  tone?: "good" | "warn" | "bad";
  className?: string;
}) {
  const color =
    tone === "bad"
      ? "text-bad"
      : tone === "warn"
        ? "text-warn"
        : tone === "good"
          ? "text-good"
          : "text-text";
  return (
    <div
      className={cn("min-w-0 rounded-xl border border-border bg-surface px-4 py-3.5", className)}
    >
      <p className="truncate text-[11px] font-semibold tracking-wide text-muted uppercase">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-[26px] leading-8 font-semibold tracking-tight tabular-nums",
          color,
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 truncate text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

const CHIP =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap transition select-none sm:h-8";
const CHIP_ON = "border-accent/30 bg-accent-soft text-accent";
const CHIP_OFF =
  "border-border bg-surface text-muted hover:border-border-strong hover:text-text active:bg-surface-2";

export function chipClass(active: boolean, extra?: string): string {
  return cn(CHIP, active ? CHIP_ON : CHIP_OFF, extra);
}

/** A toolbar filter pill that is a link (month, threshold, tab). */
export function ChipLink({
  href,
  active,
  children,
  className,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={chipClass(active, className)}
    >
      {children}
    </Link>
  );
}

/** A row of chips. Scrolls sideways on a phone instead of wrapping into a tall stack. */
export function ChipRow({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <nav
      {...rest}
      className={cn(
        "-mx-4 flex max-w-[100vw] gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:max-w-full sm:flex-wrap sm:overflow-visible sm:px-0",
        className,
      )}
    >
      {children}
    </nav>
  );
}

/**
 * One settings topic: a 13px title, a short explanation in muted text, the fields, and one primary action in
 * the footer. `flush` drops the body padding for a list or table that runs edge to edge.
 */
export function SettingsCard({
  title,
  description,
  aside,
  children,
  footer,
  flush,
  className,
  ...rest
}: {
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  className?: string;
  id?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <Card className={cn("p-0", className)} {...rest}>
      <div className={cn("px-4 pt-4", flush ? "pb-3" : "pb-0")}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-[13px] font-semibold text-text">{title}</h2>
          {aside ? <div className="shrink-0 text-xs text-muted">{aside}</div> : null}
        </div>
        {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      </div>
      {children !== undefined && children !== null ? (
        <div className={cn(flush ? "" : "px-4 pt-3 pb-4")}>{children}</div>
      ) : (
        <div className="pb-4" />
      )}
      {footer ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}

/** A quiet status line inside a card: a warning the person can act on, or a success note. */
export function Note({
  tone = "neutral",
  children,
  className,
  role,
}: {
  tone?: "neutral" | "warn" | "bad" | "good";
  children: ReactNode;
  className?: string;
  role?: string;
}) {
  const look =
    tone === "warn"
      ? "border-warn/30 bg-warn-soft text-warn"
      : tone === "bad"
        ? "border-bad/30 bg-bad-soft text-bad"
        : tone === "good"
          ? "border-good/30 bg-good-soft text-good"
          : "border-border bg-surface-2 text-text-2";
  return (
    <p role={role} className={cn("rounded-lg border px-3 py-2 text-sm", look, className)}>
      {children}
    </p>
  );
}

/** The dense sheet's header row and cell classes, so every table in the area lines up the same way. */
export const SHEET = {
  table: "w-full text-[13px]",
  thead: "bg-surface-3 text-left text-[11px] font-semibold tracking-wide text-muted uppercase",
  th: "px-3 py-2 font-semibold first:pl-4 last:pr-4",
  thNum: "px-3 py-2 text-right font-semibold first:pl-4 last:pr-4",
  tbody: "divide-y divide-border",
  tr: "transition hover:bg-surface-3",
  td: "px-3 py-2 align-middle first:pl-4 last:pr-4",
  tdNum: "px-3 py-2 text-right align-middle tabular-nums first:pl-4 last:pr-4",
} as const;

/** A 16px Lucide-style icon: pass the path data. */
export function Icon({ d, className }: { d: string; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={cn("size-4 shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

export const ICON = {
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  calendar:
    "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  check: "M20 6 9 17l-5-5",
  chevronDown: "m6 9 6 6 6-6",
  close: "M18 6 6 18M6 6l12 12",
  flame:
    "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z",
  upload: "M12 3v12m0-12 4 4m-4-4-4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  alert:
    "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  external: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  download: "M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
} as const;
