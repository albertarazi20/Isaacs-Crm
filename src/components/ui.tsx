import Link from "next/link";
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
  underwriting: "var(--g-underwriting)",
  funded: "var(--g-funded)",
  trouble: "var(--g-trouble)",
  exit: "var(--g-exit)",
};

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

/*
 * One primary action per screen carries the brand gradient; everything else is a quiet bordered or ghost
 * button. Pressed states dim rather than move, so nothing around a button jumps.
 */
const VARIANT: Record<Variant, string> = {
  primary:
    "bg-[image:var(--brand-gradient)] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.35),0_1px_2px_rgb(10_10_16/0.25)] hover:brightness-[1.06] active:brightness-95",
  secondary:
    "border border-border bg-surface text-text shadow-card hover:border-border-strong hover:bg-surface-3 active:bg-surface-2",
  ghost: "text-text-2 hover:bg-surface-2 hover:text-text active:bg-surface-2",
  danger: "border border-bad/25 bg-bad-soft text-bad hover:border-bad/50 active:brightness-95",
};
// "sm" is the dense desktop size; under the sm: breakpoint a thumb needs 40px.
const SIZE: Record<Size, string> = {
  sm: "h-10 px-3 text-sm sm:h-8 sm:px-2.5 sm:text-[13px]",
  md: "h-10 px-4 text-sm sm:h-9",
};
const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition select-none disabled:cursor-not-allowed disabled:opacity-50";

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

const FIELD =
  "w-full rounded-lg border border-border bg-surface px-3 text-sm text-text transition placeholder:text-muted/70 hover:border-border-strong focus:border-accent focus:ring-2 focus:ring-ring focus:outline-none disabled:bg-surface-2 disabled:text-muted";

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
    <label className={cn("block space-y-1", className)}>
      <span className="text-[12px] font-medium text-text-2">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

type Tone = "neutral" | "good" | "warn" | "bad" | "accent" | "info";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-text-2",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  accent: "bg-accent-soft text-accent",
  info: "bg-info-soft text-info",
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
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap",
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
    <section className={cn("rounded-xl border border-border bg-surface", className)}>
      {children}
    </section>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[13px] font-semibold text-text">{children}</h2>
      {aside}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border-strong px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children ? <p className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</p> : null}
    </div>
  );
}
