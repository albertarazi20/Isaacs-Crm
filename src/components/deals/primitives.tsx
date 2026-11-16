import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, cn } from "@/components/ui";

/*
 * Primitives the deals, board and funders screens share and ui.tsx does not have yet: 16px Lucide-style
 * icons, the filter chip with its count, the page header, a stat (label over a number), the status tones for
 * deals and lender rows, and the table header class. Pure markup — a server page and a client component can
 * both import it.
 */

export type IconName =
  | "chevron-down"
  | "chevron-right"
  | "arrow-left"
  | "arrow-right"
  | "check"
  | "x"
  | "plus"
  | "clock"
  | "mail"
  | "phone"
  | "file"
  | "send"
  | "external"
  | "link"
  | "alert"
  | "square"
  | "upload"
  | "refresh"
  | "sparkles"
  | "building"
  | "inbox"
  | "copy"
  | "filter";

const PATHS: Record<IconName, ReactNode> = {
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  "arrow-left": (
    <>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </>
  ),
  "arrow-right": (
    <>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  x: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  plus: (
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </>
  ),
  mail: (
    <>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </>
  ),
  phone: (
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
  ),
  file: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  send: (
    <>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </>
  ),
  external: (
    <>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  square: <rect width="18" height="18" x="3" y="3" rx="2" />,
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </>
  ),
  sparkles: (
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
  ),
  building: (
    <>
      <rect width="16" height="20" x="4" y="2" rx="2" />
      <path d="M9 22v-4h6v4" />
      <path d="M8 6h.01M16 6h.01M12 6h.01M12 10h.01M12 14h.01M16 10h.01M16 14h.01M8 10h.01M8 14h.01" />
    </>
  ),
  inbox: (
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  copy: (
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
  filter: <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />,
};

/** A 16px line icon from the Lucide set; decorative, so hidden from the accessibility tree. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
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
      {PATHS[name]}
    </svg>
  );
}

/** A filter chip in a toolbar: the label with its count; the active one is inked. 40px tall on a phone. */
export function FilterChip({
  href,
  active,
  count,
  tone = "neutral",
  title,
  children,
}: {
  href: string;
  active: boolean;
  count?: number | null;
  /** "warn" draws attention to a chip that needs a look (the review tray with proposals in it). */
  tone?: "neutral" | "warn";
  title?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      title={title}
      className={cn(
        "inline-flex h-10 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap transition sm:h-8",
        active
          ? "border-text bg-text text-bg"
          : tone === "warn"
            ? "border-warn/40 bg-warn-soft text-warn hover:border-warn/60"
            : "border-border bg-surface text-text-2 hover:border-border-strong hover:text-text",
      )}
    >
      {children}
      {count ? (
        <span className={cn("tabular-nums", active ? "opacity-70" : "text-muted")}>{count}</span>
      ) : null}
    </Link>
  );
}

/** The page header: title left, one line of context under it, the actions right (one primary at most). */
export function PageHeader({
  title,
  context,
  actions,
}: {
  title: ReactNode;
  context?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {context ? <p className="mt-0.5 max-w-3xl text-sm text-muted">{context}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * A label over a number, for a stat row inside a `<dl>`. The label is the 11px caps label by default; `caps`
 * off keeps it in sentence case (innerText follows text-transform, and the browser suites read the scoreboard
 * as "Sent 1").
 */
export function Stat({
  label,
  value,
  sub,
  tone,
  caps = true,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: string | undefined;
  tone?: "good" | "warn" | "bad";
  caps?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt
        className={cn(
          "text-[11px] font-semibold text-muted",
          caps ? "tracking-wide uppercase" : "font-medium",
        )}
      >
        {label}
      </dt>
      <dd
        className={cn(
          "mt-0.5 text-base leading-6 font-semibold tabular-nums",
          tone === "good" && "text-good",
          tone === "warn" && "text-warn",
          tone === "bad" && "text-bad",
        )}
      >
        {value}
      </dd>
      {sub ? <dd className="truncate text-xs text-muted">{sub}</dd> : null}
    </div>
  );
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "accent" | "info";

/** The tone of a deal's derived status, for the Badge on a row. */
export const DEAL_TONE: Record<string, Tone> = {
  working: "neutral",
  working_ops: "info",
  kicked_back: "bad",
  pending_lenders: "info",
  stips_needed: "warn",
  needs_pitch: "good",
  pitched: "good",
  contracts_out: "accent",
  contracts_in: "accent",
  funding_call: "accent",
  funded: "good",
  declined_by_all: "bad",
  declined: "neutral",
  lost: "neutral",
  dead: "neutral",
};

/** The tone of a lender row's status. */
export const SUB_TONE: Record<string, Tone> = {
  sent: "info",
  stips_requested: "warn",
  approved: "good",
  revised: "good",
  contracts_out: "accent",
  contracts_in: "accent",
  funding_call: "accent",
  funded: "good",
  declined: "bad",
  no_response: "neutral",
  withdrawn: "neutral",
  expired: "neutral",
};

/** The Badge background classes by tone, for controls that need to look like a Badge (the status select). */
export const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-surface-2 text-text-2",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  accent: "bg-accent-soft text-accent",
  info: "bg-info-soft text-info",
};

export function DealStatusBadge({ status, label }: { status: string; label: string }) {
  return <Badge tone={DEAL_TONE[status] ?? "accent"}>{label}</Badge>;
}

/** The header cell of a dense table. */
export const TH =
  "px-3 py-2 text-left text-[11px] font-semibold tracking-wide text-muted uppercase first:pl-4 last:pr-4";
/** The body cell of a dense table. */
export const TD = "px-3 py-2 align-middle first:pl-4 last:pr-4";
