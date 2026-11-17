import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/components/ui";

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
 * One settings topic. On a wide screen it reads in two columns: on the left the title, one line of what it does and
 * its status; on the right a panel with the controls and, in its footer, the one action. On a phone the two stack.
 * `flush` drops the panel padding for a list or table that runs edge to edge. A hairline separates each topic from
 * the one above, so a page is a calm column of them and never a wall of equal cards.
 */
export function SettingsCard({
  title,
  description,
  aside,
  children,
  footer,
  flush,
  className,
  panelClassName,
  ...rest
}: {
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  className?: string;
  panelClassName?: string;
  id?: string;
  "aria-labelledby"?: string;
}) {
  const hasBody = children !== undefined && children !== null && children !== false;
  return (
    <section
      className={cn(
        "grid scroll-mt-20 items-start gap-x-10 gap-y-3.5 border-t border-border py-6 xl:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] xl:py-8",
        className,
      )}
      {...rest}
    >
      <div className="min-w-0 xl:pt-0.5">
        <div className="flex items-start justify-between gap-3 xl:block">
          <h2 className="text-[15px] leading-6 font-semibold tracking-[-0.01em] text-text">
            {title}
          </h2>
          {aside ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-muted xl:mt-2.5">
              {aside}
            </div>
          ) : null}
        </div>
        {description ? (
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted xl:mt-1.5">
            {description}
          </p>
        ) : null}
      </div>
      {hasBody || footer ? (
        <div
          className={cn(
            "min-w-0 overflow-hidden rounded-2xl border border-border bg-surface",
            panelClassName,
          )}
        >
          {hasBody ? (
            <div
              className={
                flush ? "[&>:first-child]:border-t-0 [&>div.pb-3:first-child]:pt-4" : "p-4 sm:p-5"
              }
            >
              {children}
            </div>
          ) : null}
          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-3/50 px-4 py-3 sm:px-5">
              {footer}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** One line inside a flush panel: what it is on the left, its control or status on the right. */
export function SettingRow({
  label,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border px-4 py-3 sm:px-5",
        className,
      )}
    >
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-sm font-medium">{label}</p>
        {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
      </div>
      {children ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

const CHIP_TONE = {
  neutral: "bg-surface-2 text-text-2 ring-border",
  good: "bg-good-soft text-good ring-good/20",
  warn: "bg-warn-soft text-warn ring-warn/20",
  bad: "bg-bad-soft text-bad ring-bad/20",
  accent: "bg-accent-soft text-accent ring-accent/25",
  info: "bg-info-soft text-info ring-info/20",
} as const;

/** A connection's state as a pill with a dot: connected, needs attention, off. */
export function StatusChip({
  tone = "neutral",
  children,
  className,
}: {
  tone?: keyof typeof CHIP_TONE;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11.5px] font-semibold whitespace-nowrap ring-1 ring-inset",
        CHIP_TONE[tone],
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
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
    <p
      role={role}
      className={cn("rounded-xl border px-3.5 py-2.5 text-[13px] leading-relaxed", look, className)}
    >
      {children}
    </p>
  );
}

/** The dense sheet's header row and cell classes, so every table in the area lines up the same way. */
export const SHEET = {
  table: "w-full text-[13px]",
  thead: "text-left",
  th: "eyebrow border-b border-border bg-surface-3/60 px-3 py-2.5 whitespace-nowrap first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
  thNum:
    "eyebrow border-b border-border bg-surface-3/60 px-3 py-2.5 text-right whitespace-nowrap first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
  tbody: "divide-y divide-border",
  tr: "transition-colors duration-150 hover:bg-surface-2/50",
  td: "h-12 px-3 py-2 align-middle first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
  tdNum:
    "h-12 px-3 py-2 text-right align-middle tabular-nums first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
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
  copy: "M9 9h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2",
  plus: "M12 5v14M5 12h14",
  mail: "M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm-1 1 9 6 9-6",
  phone:
    "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
  snow: "M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1 19.1 4.9",
  sun: "M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  monitor: "M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm4 15h8m-4-3v3",
  refresh: "M20 11a8 8 0 0 0-14.3-4.3L4 8m0-4v4h4m-4 5a8 8 0 0 0 14.3 4.3L20 16m0 4v-4h-4",
  shield: "M12 3 5 6v6c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-3z",
  plug: "M9 3v5m6-5v5M7 8h10v4a5 5 0 0 1-10 0V8zm5 9v4",
  sheet:
    "M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm-1 6h16M4 15h16M10 9v12",
} as const;
