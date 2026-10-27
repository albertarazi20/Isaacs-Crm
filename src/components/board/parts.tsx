import type { ReactNode } from "react";
import { useApp } from "@/components/app-context";
import { cn } from "@/components/ui";
import { FREQUENCY_ADJECTIVE } from "@/components/stage-move/forms";
import type { ClientCard } from "@/lib/data/types";
import { formatDate, relativeDay } from "@/lib/format";
import type { ISODate } from "@/lib/mca/dates";
import { reminderText } from "@/lib/mca/reminder";
import { TIMER_LABELS } from "@/lib/mca/stages";
import { formatMoney } from "@/lib/money";

type Tone = "neutral" | "good" | "warn" | "bad" | "accent";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  accent: "bg-accent-soft text-accent",
};

/** Same look as ui.tsx's Badge, plus a tooltip. */
export function Pill({
  tone = "neutral",
  title,
  className,
  children,
}: {
  tone?: Tone;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const SHORT_KIND = {
  follow_up: "",
  check_in: "Check-in ",
  renewal: "Renewal call ",
  scheduled_call: "Call booked ",
  chase: "Chase funder ",
} as const;

/**
 * The next-follow-up chip. Red says "overdue" and amber says "Today" in words as well, so colour
 * is never the only signal.
 */
export function DueChip({
  card,
  today,
  withDate,
}: {
  card: ClientCard;
  today: ISODate;
  withDate?: boolean;
}) {
  const { timezone } = useApp();
  const reminder = card.scheduled_call_at ? (
    <ReminderTag
      text={reminderText(card.scheduled_call_at, card.reminder_channel, timezone, today)}
    />
  ) : null;
  // A booked reminder is the next thing due, so its tag stands in for the plain date chip.
  if (reminder && card.next_due_kind === "scheduled_call") return reminder;
  if (card.next_due_on === null) return <Pill tone="bad">No follow-up date</Pill>;
  const rel = relativeDay(card.next_due_on, today);
  const tone = card.next_due_on < today ? "bad" : card.next_due_on === today ? "warn" : "neutral";
  const kind = card.next_due_kind ?? "follow_up";
  const exact = formatDate(card.next_due_on, today);
  const chip = (
    <Pill tone={tone} className="gap-1" title={`${TIMER_LABELS[kind]}: ${exact} (${rel})`}>
      <span aria-hidden>{tone === "bad" ? "!" : tone === "warn" ? "●" : "◷"}</span>
      <span>
        {kind === "follow_up" ? <span className="sr-only">Follow up: </span> : null}
        {SHORT_KIND[kind]}
        {rel}
        {withDate && tone === "neutral" ? ` · ${exact}` : ""}
      </span>
    </Pill>
  );
  if (!reminder) return chip;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {reminder}
      {chip}
    </span>
  );
}

/** The bright yellow "Reminder" flag: it is the one thing on a card that cannot be missed. */
export function ReminderTag({ text }: { text: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-[#ffd400] px-1.5 py-0.5 text-xs font-bold whitespace-nowrap text-black shadow-sm"
      title="Reminder"
    >
      <span aria-hidden>⏰</span>
      <span className="sr-only">Reminder: </span>
      {text}
    </span>
  );
}

/** Thin bar with a tick at 50%, where the renewal call is due. */
export function PaydownBar({ pct }: { pct: number }) {
  return (
    <div
      role="progressbar"
      aria-label="Paid down"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className="relative h-1.5 w-full rounded-full bg-surface-2"
    >
      <div
        className={cn("h-full rounded-full", pct >= 50 ? "bg-accent" : "bg-good")}
        style={{ width: `${pct}%` }}
      />
      <span
        aria-hidden
        title="50% paid down — renewal call"
        className="absolute -top-0.5 left-1/2 h-2.5 w-px bg-text/60"
      />
    </div>
  );
}

/** "$550 daily remittance". */
export function remittanceText(card: ClientCard): string | null {
  if (card.funding_payment_cents === null || card.funding_frequency === null) return null;
  return `${formatMoney(card.funding_payment_cents)} ${FREQUENCY_ADJECTIVE[card.funding_frequency]} remittance`;
}
