"use client";

import Link from "next/link";
import { memo, useState } from "react";
import type { Priority } from "@/lib/data/priority";
import type { ClientCard } from "@/lib/data/types";
import { relativeDay, timeAgo } from "@/lib/format";
import { bookedToday } from "@/lib/mca/booked";
import { reminderText } from "@/lib/mca/reminder";
import { formatUS } from "@/lib/mca/phone";
import { timerLabel } from "@/lib/mca/stages";
import { formatMoneyCompact } from "@/lib/money";
import { useApp } from "./app-context";
import { ReminderTag } from "@/components/ReminderTag";
import { ContactActions } from "./ContactActions";
import { toggleHot } from "./power/prefs";
import { SnoozeMenu } from "./power/SnoozeMenu";
import { StageBadge } from "./StageBadge";
import { Avatar, Badge, cn } from "./ui";

/** "$80k at stake": click it for the working. A tooltip alone would never show on a phone. */
function Stake({ priority }: { priority: Priority }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        title={priority.explanation}
        // the order's working, for the browser tests only: a rep reads plain words, not a score
        data-score={Math.round(priority.score)}
        onClick={() => setOpen((v) => !v)}
        // on a phone the button is a 40px tall target; the pill inside keeps its size
        className="group/stake inline-flex items-center rounded-full transition duration-150 active:scale-[0.97] max-sm:min-h-10"
      >
        <span className="inline-flex items-center rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent tabular-nums ring-1 ring-accent/25 transition duration-150 ring-inset group-hover/stake:brightness-110">
          {priority.basis === "unknown"
            ? "amount not set"
            : `${formatMoneyCompact(priority.atStakeCents)} at stake`}
        </span>
      </button>
      {open ? (
        <p className="basis-full text-xs text-muted" role="note">
          {priority.explanation}
        </p>
      ) : null}
    </>
  );
}

function Star({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-4"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3z" />
    </svg>
  );
}

/** One merchant in the call list: who, why now, the last thing said, and every way to reach or defer them. */
export const ClientRow = memo(function ClientRow({
  card,
  priority,
  hot = false,
  snoozeCount = 0,
}: {
  card: ClientCard;
  /** Today only: the score, shown as "$ at stake". */
  priority?: Priority;
  /** Today only: starred clients go to the top. Kept on the merchant, so every device agrees. */
  hot?: boolean;
  /** Times this merchant's date was pushed in the last 14 days. */
  snoozeCount?: number;
}) {
  const { today, nowMs, timezone } = useApp();
  const booked = bookedToday(card, today, timezone);
  const due = card.next_due_on;
  const overdue = due !== null && due < today;
  const isToday = due === today;
  const who = [card.contact_name, card.phone ? formatUS(card.phone) : "", card.industry]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="group flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 transition-colors duration-150 hover:bg-surface-2/50 sm:px-4">
      <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
        <Avatar name={card.business_name} size={34} className="mt-0.5 max-sm:hidden" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={`/clients/${card.id}`}
              className="inline-flex items-center text-sm font-semibold tracking-tight transition-colors hover:text-accent-strong max-sm:min-h-10"
            >
              {card.business_name}
            </Link>
            <StageBadge stage={card.stage} />
            {due ? (
              <Badge tone={overdue ? "warn" : isToday ? "accent" : "neutral"}>
                {card.next_due_kind ? `${timerLabel(card.next_due_kind)} · ` : ""}
                {relativeDay(due, today)}
              </Badge>
            ) : null}
            {card.scheduled_call_at ? (
              <ReminderTag
                text={reminderText(card.scheduled_call_at, card.reminder_channel, timezone, today)}
              />
            ) : null}
            {snoozeCount >= 2 ? (
              <Badge tone={snoozeCount >= 3 ? "warn" : "neutral"} className="whitespace-nowrap">
                <span title="Times this merchant's date was pushed in the last 14 days">
                  snoozed {snoozeCount}×
                </span>
              </Badge>
            ) : null}
            {priority ? <Stake priority={priority} /> : null}
          </div>
          <p className="mt-1 text-xs text-muted sm:truncate">
            {who}
            {card.wanted_amount_cents ? (
              <span className="font-medium text-text-2 tabular-nums">
                {who ? " · " : ""}wants {formatMoneyCompact(card.wanted_amount_cents)}
              </span>
            ) : null}
          </p>
          {card.last_call_at ? (
            <p
              className="mt-0.5 line-clamp-2 text-xs sm:line-clamp-1"
              title={card.last_call_note ?? undefined}
            >
              <span className="text-muted">
                Last call {timeAgo(card.last_call_at, new Date(nowMs))}
                {card.last_call_note ? ": " : ""}
              </span>
              {card.last_call_note ? (
                <span className="text-text-2 italic">“{card.last_call_note}”</span>
              ) : null}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted">Never called.</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 max-sm:w-full sm:ml-auto">
        <ContactActions client={card} />
        <span className="ml-auto flex items-center gap-0.5 sm:ml-1">
          {priority ? (
            <button
              type="button"
              aria-pressed={hot}
              aria-label={hot ? `Unstar ${card.business_name}` : `Star ${card.business_name}`}
              title={hot ? "Starred: always on top" : "Star: always on top of Today"}
              onClick={() => void toggleHot(card.id, hot)}
              className={cn(
                "inline-flex size-10 shrink-0 items-center justify-center rounded-full transition duration-150 hover:bg-surface-2 active:scale-90 sm:size-8",
                hot ? "text-warn" : "text-muted hover:text-text",
              )}
            >
              <Star filled={hot} />
            </button>
          ) : null}
          {booked ? (
            // Snoozing can't move an appointment, so don't offer a button that appears to do nothing.
            <Link
              href={`/clients/${card.id}`}
              title="This merchant has a call booked today. Move or cancel the call on their page."
              className="inline-flex h-10 items-center rounded-full px-3 text-[13px] font-medium whitespace-nowrap text-accent transition duration-150 hover:bg-accent-soft active:scale-[0.97] sm:h-8"
            >
              Move the call
            </Link>
          ) : (
            <SnoozeMenu card={card} />
          )}
        </span>
      </div>
    </article>
  );
});
