"use client";

import Link from "next/link";
import { memo, useState } from "react";
import type { Priority } from "@/lib/data/priority";
import type { ClientCard } from "@/lib/data/types";
import { cardFundingTerms } from "@/lib/data/views";
import { relativeDay, timeAgo } from "@/lib/format";
import { bookedToday } from "@/lib/mca/booked";
import { reminderText } from "@/lib/mca/reminder";
import { balanceCents, paydownPct } from "@/lib/mca/funding";
import { formatUS } from "@/lib/mca/phone";
import { TIMER_LABELS } from "@/lib/mca/stages";
import { formatMoney, formatMoneyCompact } from "@/lib/money";
import { useApp } from "./app-context";
import { ReminderTag } from "@/components/ReminderTag";
import { ContactActions } from "./ContactActions";
import { toggleHot } from "./power/prefs";
import { SnoozeMenu } from "./power/SnoozeMenu";
import { StageBadge } from "./StageBadge";
import { Badge, cn } from "./ui";

/** "$80k at stake": click it for the working. A tooltip alone would never show on a phone. */
function Stake({ priority }: { priority: Priority }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        title={priority.explanation}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md bg-accent-soft px-1.5 py-0.5 text-xs font-semibold text-accent tabular-nums hover:opacity-80"
      >
        {priority.basis === "unknown"
          ? "amount not set"
          : `${formatMoneyCompact(priority.atStakeCents)} at stake`}
      </button>
      {open ? (
        <p className="basis-full text-xs text-muted" role="note">
          {priority.explanation}
        </p>
      ) : null}
    </>
  );
}

export const ClientRow = memo(function ClientRow({
  card,
  showPaydown = false,
  priority,
  hot = false,
  snoozeCount = 0,
}: {
  card: ClientCard;
  showPaydown?: boolean;
  /** Today only: the money-first score, shown as "$ at stake". */
  priority?: Priority;
  /** Today only: starred clients go to the top. Kept on the merchant, so every device agrees. */
  hot?: boolean;
  /** Times this client's date was pushed in the last 14 days. */
  snoozeCount?: number;
}) {
  const { today, nowMs, timezone } = useApp();
  const booked = bookedToday(card, today, timezone);
  const due = card.next_due_on;
  const overdue = due !== null && due < today;
  const isToday = due === today;
  const terms = showPaydown ? cardFundingTerms(card) : null;
  const pct = terms ? paydownPct(terms, today) : null;

  return (
    <article
      className={cn(
        "rounded-xl border bg-surface p-3.5",
        overdue ? "border-bad/50" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/clients/${card.id}`}
              className="text-base font-semibold hover:text-accent hover:underline"
            >
              {card.business_name}
            </Link>
            <StageBadge stage={card.stage} />
            {snoozeCount >= 2 ? (
              <Badge tone={snoozeCount >= 3 ? "warn" : "neutral"} className="whitespace-nowrap">
                <span title="Times this client's date was pushed in the last 14 days">
                  snoozed {snoozeCount}×
                </span>
              </Badge>
            ) : null}
            {card.scheduled_call_at ? (
              <ReminderTag
                text={reminderText(card.scheduled_call_at, card.reminder_channel, timezone, today)}
              />
            ) : null}
            {due ? (
              <Badge tone={overdue ? "bad" : isToday ? "warn" : "neutral"}>
                {card.next_due_kind ? `${TIMER_LABELS[card.next_due_kind]} · ` : ""}
                {relativeDay(due, today)}
              </Badge>
            ) : null}
            {priority ? <Stake priority={priority} /> : null}
          </div>
          <p className="text-sm text-muted">
            {[card.contact_name, card.phone ? formatUS(card.phone) : "", card.industry]
              .filter(Boolean)
              .join(" · ")}
            {card.wanted_amount_cents ? (
              <span className="font-medium text-text">
                {" "}
                · wants {formatMoneyCompact(card.wanted_amount_cents)}
              </span>
            ) : null}
            {card.position_count > 0 ? (
              <span>
                {" "}
                · {card.position_count} other advance{card.position_count === 1 ? "" : "s"}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {priority ? (
            <button
              type="button"
              aria-pressed={hot}
              aria-label={hot ? `Unstar ${card.business_name}` : `Star ${card.business_name}`}
              title={hot ? "Starred: always on top" : "Star: always on top of Today"}
              onClick={() => void toggleHot(card.id, hot)}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-lg text-base hover:bg-surface-2",
                hot ? "text-warn" : "text-muted",
              )}
            >
              {hot ? "★" : "☆"}
            </button>
          ) : null}
          {booked ? (
            // Snoozing can't move an appointment, so don't offer a button that appears to do nothing.
            <Link
              href={`/clients/${card.id}`}
              title="This merchant has a call booked today. Move or cancel the call on their page."
              className="rounded-lg px-2 py-1 text-xs font-medium text-accent hover:bg-surface-2"
            >
              Move the call
            </Link>
          ) : (
            <SnoozeMenu card={card} />
          )}
        </div>
      </div>

      {card.last_call_at ? (
        <p className="mt-2 line-clamp-2 text-sm">
          <span className="text-muted">
            Last call {timeAgo(card.last_call_at, new Date(nowMs))}
            {card.last_call_note ? ": " : ""}
          </span>
          {card.last_call_note ? <span className="italic">“{card.last_call_note}”</span> : null}
        </p>
      ) : (
        <p className="mt-2 text-sm text-muted">Never called.</p>
      )}

      {pct !== null && terms ? (
        <div className="mt-2.5 space-y-1">
          <div
            className="relative h-2 overflow-hidden rounded-full bg-surface-2"
            role="img"
            aria-label={`${pct}% paid down`}
          >
            <div
              className="h-full rounded-full bg-good"
              style={{ width: `${Math.min(100, pct)}%` }}
            />
            <div className="absolute inset-y-0 left-1/2 w-px bg-text/40" aria-hidden />
          </div>
          <p className="text-xs text-muted">
            {pct}% paid down · {formatMoney(balanceCents(terms, today))} left ·{" "}
            {formatMoney(terms.paymentCents)} {terms.frequency} remittance
          </p>
        </div>
      ) : null}

      <div className="mt-3">
        <ContactActions client={card} />
      </div>
    </article>
  );
});
