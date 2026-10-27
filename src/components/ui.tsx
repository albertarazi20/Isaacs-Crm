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

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-fg shadow-sm shadow-accent/25 hover:brightness-110 active:brightness-95",
  secondary:
    "border border-border bg-surface text-text shadow-sm hover:border-accent/40 hover:bg-surface-2",
  ghost: "text-muted hover:bg-surface-2 hover:text-text",
  danger: "bg-bad-soft text-bad hover:opacity-80",
};
// "sm" is the dense desktop size; under the sm: breakpoint a thumb needs 40px (I-12).
const SIZE: Record<Size, string> = {
  sm: "h-10 px-3 text-sm sm:h-8 sm:px-2.5",
  md: "h-10 px-4 text-sm",
};
const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

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
  "w-full rounded-lg border border-border bg-surface px-3 text-sm text-text placeholder:text-muted/70 focus:border-accent";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(FIELD, "h-10", className)} {...rest} />;
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(FIELD, "min-h-24 py-2", className)} {...rest} />;
}
export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(FIELD, "h-10", className)} {...rest} />;
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
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

type Tone = "neutral" | "good" | "warn" | "bad" | "accent";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  accent: "bg-accent-soft text-accent",
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
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-semibold",
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
      <h2 className="text-sm font-semibold tracking-wide text-muted uppercase">{children}</h2>
      {aside}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center">
      <p className="font-medium">{title}</p>
      {children ? <p className="mt-1 text-sm text-muted">{children}</p> : null}
    </div>
  );
}
