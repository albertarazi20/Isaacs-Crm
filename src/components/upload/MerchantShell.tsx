import Image from "next/image";
import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import { Glyph, type GlyphName } from "@/components/shell/icons";

/** The Selective Capital wordmark, the right one for the mode. */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <>
      <Image
        src="/brand/SC-horizontal-light-web.png"
        alt="Selective Capital"
        width={800}
        height={129}
        priority
        className={cn("only-light h-7 w-auto", className)}
      />
      <Image
        src="/brand/SC-horizontal-dark-web.png"
        alt="Selective Capital"
        width={800}
        height={129}
        priority
        className={cn("only-dark h-7 w-auto", className)}
      />
    </>
  );
}

/**
 * The frame every page a merchant opens shares: the wordmark on a glass bar, what this page is for, and one narrow
 * column that reads well on a phone. No navigation: each of these pages has exactly one job.
 */
export function MerchantShell({
  label,
  wide,
  paper,
  className,
  children,
}: {
  /** What this page is, in a word or two ("Documents"). */
  label?: string;
  wide?: boolean;
  /** Always light, on warm paper under a near-black bar, whatever the CRM's own mode (the offer page). */
  paper?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const column = wide ? "max-w-2xl" : "max-w-lg";
  return (
    <div
      className={cn("flex min-h-dvh flex-col", paper && "paper bg-[#f6f5f1] text-text", className)}
    >
      {paper ? (
        <header className="sticky top-0 z-20 border-b border-white/10 bg-[#0b0b12]">
          <div className={cn("mx-auto flex h-16 items-center justify-between gap-4 px-5", column)}>
            <Image
              src="/brand/SC-horizontal-dark-web.png"
              alt="Selective Capital"
              width={800}
              height={129}
              priority
              className="h-[22px] w-auto"
            />
            {label ? (
              <p className="truncate text-[11px] font-semibold tracking-[0.22em] text-violet-300 uppercase">
                {label}
              </p>
            ) : null}
          </div>
        </header>
      ) : (
        <header className="glass sticky top-0 z-20 border-b border-border">
          <div className={cn("mx-auto flex h-14 items-center justify-between gap-4 px-5", column)}>
            <BrandLogo className="h-[22px]" />
            {label ? <p className="eyebrow truncate">{label}</p> : null}
          </div>
        </header>
      )}
      <main
        className={cn(
          "mx-auto w-full flex-1 animate-rise px-5 pt-8 pb-[max(2.5rem,env(safe-area-inset-bottom))] sm:pt-12",
          column,
        )}
      >
        {children}
      </main>
    </div>
  );
}

/** The shop's name as a small label, unless the wordmark above already says exactly that. */
export function shopLabel(name: string): string | undefined {
  return name.trim().toLowerCase() === "selective capital" ? undefined : name;
}

/** The top of a merchant page: who it is from, the one thing to do, and a plain sentence about it. */
export function MerchantHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div>
      {eyebrow ? <p className="eyebrow mb-2">{eyebrow}</p> : null}
      <h1 className="text-[28px] leading-[1.1] font-semibold tracking-[-0.03em] text-balance sm:text-[34px]">
        {title}
      </h1>
      {children ? (
        <p className="mt-3 text-[15px] leading-relaxed text-pretty text-text-2">{children}</p>
      ) : null}
    </div>
  );
}

const NOTICE_TONE = {
  good: "bg-good-soft text-good ring-good/25",
  warn: "bg-warn-soft text-warn ring-warn/25",
  accent: "bg-accent-soft text-accent ring-accent/25",
} as const;

/** A whole-page message: a link that no longer works, or a job that is already done. */
export function MerchantNotice({
  icon,
  tone = "accent",
  title,
  children,
}: {
  icon: GlyphName;
  tone?: keyof typeof NOTICE_TONE;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-border bg-surface px-6 py-9 text-center sm:px-9 sm:py-11">
      <span
        aria-hidden
        className={cn(
          "mx-auto flex size-14 animate-pop items-center justify-center rounded-full ring-1",
          NOTICE_TONE[tone],
        )}
      >
        <Glyph name={icon} className="size-6" strokeWidth={2} />
      </span>
      <h1 className="mt-5 text-[22px] leading-tight font-semibold tracking-[-0.025em] text-balance sm:text-2xl">
        {title}
      </h1>
      {children ? (
        <p className="mx-auto mt-2.5 max-w-sm text-[15px] leading-relaxed text-pretty text-text-2">
          {children}
        </p>
      ) : null}
    </section>
  );
}
