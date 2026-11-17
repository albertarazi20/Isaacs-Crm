import Link from "next/link";
import { useId } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import type { StageGroup } from "@/lib/mca/stages";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export const GROUP_COLOR: Record<StageGroup, string> = {
  prospecting: "var(--g-prospecting)",
  application: "var(--g-underwriting)",
  exit: "var(--g-exit)",
};

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

/*
 * Buttons are pills. One primary action per screen carries the brand gradient and its glow; the rest are smoked
 * glass or ghosts. Every button answers the press at once (it shrinks a hair), so the interface feels held.
 */
const VARIANT: Record<Variant, string> = {
  primary:
    "bg-brand-ink font-semibold text-white shadow-glow hover:brightness-110 active:brightness-95 [text-shadow:0_1px_1px_rgb(20_10_60/0.35)]",
  secondary:
    "border border-border bg-surface text-text shadow-card hover:border-border-strong hover:bg-surface-3 active:bg-surface-2",
  ghost: "text-text-2 hover:bg-surface-2 hover:text-text active:bg-surface-2",
  danger:
    "border border-bad/25 bg-bad-soft text-bad hover:border-bad/50 hover:brightness-105 active:brightness-95",
};
// "sm" is the dense desktop size; under the sm: breakpoint a thumb needs 40px.
const SIZE: Record<Size, string> = {
  sm: "h-10 px-3.5 text-sm sm:h-8 sm:px-3 sm:text-[13px]",
  md: "h-10 px-4.5 text-sm sm:h-9 sm:px-4",
  lg: "h-12 px-6 text-[15px]",
};
const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-full font-medium whitespace-nowrap transition duration-150 ease-out select-none active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100";

export function buttonClass(
  variant: Variant = "secondary",
  size: Size = "md",
  extra?: string,
): string {
  return cn(BASE, VARIANT[variant], SIZE[size], extra);
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  className,
  children,
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}

/** A square, icon-only control. `label` is what a screen reader and the tooltip say. */
export function IconButton({
  label,
  className,
  type = "button",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted transition duration-150 hover:bg-surface-2 hover:text-text active:scale-95 sm:size-8",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

const FIELD =
  "w-full rounded-xl border border-border bg-surface-3 px-3 text-sm text-text shadow-[inset_0_1px_2px_var(--shadow-c1)] transition duration-150 placeholder:text-muted hover:border-border-strong focus:border-accent focus:bg-surface focus:ring-[3px] focus:ring-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-60";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(FIELD, "h-10 sm:h-9", className)} {...rest} />;
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(FIELD, "min-h-24 py-2", className)} {...rest} />;
}
export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(FIELD, "h-10 sm:h-9", className)} {...rest} />;
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className="text-[12px] font-medium text-text-2">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "accent" | "info";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-text-2 ring-border",
  good: "bg-good-soft text-good ring-good/20",
  warn: "bg-warn-soft text-warn ring-warn/20",
  bad: "bg-bad-soft text-bad ring-bad/20",
  accent: "bg-accent-soft text-accent ring-accent/25",
  info: "bg-info-soft text-info ring-info/20",
};
/** The tone as plain ink, for dots, icons and numbers that carry a status. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted",
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
  accent: "text-accent",
  info: "text-info",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ring-1 ring-inset",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl border border-border bg-surface", className)}>
      {children}
    </section>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[13px] font-semibold tracking-tight text-text">{children}</h2>
      {aside}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-border-strong/70 bg-surface-3/40 px-6 py-12 text-center">
      <div
        aria-hidden
        className="bg-brand-soft mx-auto mb-4 flex size-11 items-center justify-center rounded-2xl ring-1 ring-accent/20"
      >
        <span className="bg-brand size-2.5 rounded-full shadow-glow" />
      </div>
      <p className="text-sm font-semibold">{title}</p>
      {children ? <p className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** The top of a page: a small eyebrow, the title, one line of what the page is for, and its actions. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-1.5">{eyebrow}</p> : null}
        <h1 className="text-[26px] leading-[1.1] font-semibold tracking-[-0.03em] sm:text-[30px]">
          {title}
        </h1>
        {description ? <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A keyboard key. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-border bg-surface-2 px-1 font-sans text-[10.5px] font-medium text-muted shadow-[inset_0_-1px_0_var(--border)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** Initials on brand light. */
export function Avatar({
  name,
  size = 32,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const initials =
    name
      .trim()
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?";
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) }}
      className={cn(
        "bg-brand-soft inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-accent-strong ring-1 ring-accent/25",
        className,
      )}
    >
      {initials}
    </span>
  );
}

const SPARK_STROKE: Record<Tone, string> = {
  neutral: "var(--muted)",
  good: "var(--good)",
  warn: "var(--warn)",
  bad: "var(--bad)",
  accent: "var(--accent)",
  info: "var(--info)",
};

/** A small trend line with a soft fill. Decorative: the number beside it carries the meaning. */
export function Sparkline({
  values,
  tone = "accent",
  width = 120,
  height = 36,
  className,
}: {
  values: readonly number[];
  tone?: Tone;
  width?: number;
  height?: number;
  className?: string;
}) {
  const id = useId();
  const pts = values.length > 1 ? values : [0, ...values, 0].slice(0, 2);
  const max = Math.max(...pts, 1);
  const min = Math.min(...pts, 0);
  const span = max - min || 1;
  const step = width / (pts.length - 1);
  const xy = pts.map((v, i) => [i * step, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = xy[xy.length - 1] ?? [0, 0];
  const stroke = SPARK_STROKE[tone];
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("overflow-visible", className)}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={stroke} stopOpacity="0.32" />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${width} ${height} L0 ${height} Z`} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill={stroke} />
    </svg>
  );
}

/** A ring that fills with brand light. `value` is 0..1. */
export function ProgressRing({
  value,
  size = 44,
  stroke = 4,
  children,
  className,
}: {
  value: number;
  size?: number;
  stroke?: number;
  children?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg aria-hidden width={size} height={size} className="-rotate-90">
        <defs>
          <linearGradient id={id} x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#2e7bff" />
            <stop offset="0.55" stopColor="#a855f7" />
            <stop offset="1" stopColor="#d946ef" />
          </linearGradient>
        </defs>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-2)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`url(#${id})`}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          style={{ transition: "stroke-dashoffset 0.9s var(--ease-out)" }}
        />
      </svg>
      {children ? (
        <span className="absolute inset-0 flex items-center justify-center text-[11px] font-semibold tabular-nums">
          {children}
        </span>
      ) : null}
    </span>
  );
}

/** A thin bar that fills. `value` and `max` are in the same unit. */
export function Meter({
  value,
  max,
  tone = "accent",
  className,
  label,
}: {
  value: number;
  max: number;
  tone?: Tone | "brand";
  className?: string;
  /** What it measures, for a screen reader ("Emails sent today of the cap"). */
  label: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const fill =
    tone === "brand"
      ? "bg-brand"
      : {
          neutral: "bg-muted",
          good: "bg-good",
          warn: "bg-warn",
          bad: "bg-bad",
          accent: "bg-accent",
          info: "bg-info",
        }[tone];
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-2", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-700 ease-out", fill)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** How a number moved against the last period. */
export function Delta({ value, suffix = "%" }: { value: number | null; suffix?: string }) {
  if (value === null || !Number.isFinite(value))
    return <span className="text-[11px] font-medium text-muted">new</span>;
  const up = value > 0;
  const flat = value === 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
        flat ? "bg-surface-2 text-muted" : up ? "bg-good-soft text-good" : "bg-bad-soft text-bad",
      )}
    >
      <svg aria-hidden viewBox="0 0 12 12" className={cn("size-2.5", !up && !flat && "rotate-180")}>
        {flat ? (
          <path d="M2 6h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        ) : (
          <path d="M6 2.5 10 8H2z" fill="currentColor" />
        )}
      </svg>
      {Math.abs(value)}
      {suffix}
    </span>
  );
}

/** One number that matters: its label, the figure, how it moved, and an optional trend. */
export function StatCard({
  label,
  value,
  delta,
  hint,
  spark,
  tone = "accent",
  href,
  hero,
}: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  hint?: ReactNode;
  spark?: readonly number[];
  tone?: Tone;
  href?: string;
  /** The headline figure of the page: brand ring, gradient ink. */
  hero?: boolean;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow">{label}</p>
        {delta}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p
          className={cn(
            "text-[32px] leading-none font-semibold tracking-[-0.04em] tabular-nums",
            hero && "text-gradient",
          )}
        >
          {value}
        </p>
        {spark && spark.length > 1 ? (
          <Sparkline values={spark} tone={tone} width={88} height={32} className="mb-0.5" />
        ) : null}
      </div>
      {hint ? <p className="mt-2 text-xs text-muted">{hint}</p> : null}
    </>
  );
  const cls = cn(
    "block rounded-2xl border border-border bg-surface p-4 sm:p-5",
    hero && "ring-brand",
  );
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** A segmented control made of links: the current view is a raised pill. */
export function Segmented({
  items,
  label,
  className,
}: {
  items: readonly { href: string; label: ReactNode; active: boolean; count?: number }[];
  label: string;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn(
        "inline-flex max-w-full gap-0.5 overflow-x-auto rounded-full border border-border bg-surface-2/70 p-1",
        className,
      )}
    >
      {items.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          aria-current={it.active ? "page" : undefined}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap transition duration-150",
            it.active
              ? "bg-surface text-text shadow-card"
              : "text-muted hover:bg-surface/60 hover:text-text",
          )}
        >
          {it.label}
          {it.count !== undefined ? (
            <span
              className={cn(
                "rounded-full px-1.5 text-[11px] tabular-nums",
                it.active ? "bg-accent-soft text-accent" : "bg-surface-3 text-muted",
              )}
            >
              {it.count}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton h-4", className)} />;
}
