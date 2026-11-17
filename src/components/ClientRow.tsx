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
import { Icon } from "./client/icons";
import { IconButton } from "./client/primitives";
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
        className="inline-flex items-center rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-semibold text-accent tabular-nums transition hover:brightness-95"
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
  priority,
  hot = false,
  snoozeCount = 0,
}: {
  card: ClientCard;
  /** Today only: the score, shown as "$ at stake". */
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

  return (
    <article
      className={cn(
        "rounded-xl border bg-surface p-3 transition sm:p-3.5",
        overdue ? "border-bad/40" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={`/clients/${card.id}`}
              className="text-sm font-semibold hover:text-accent hover:underline"
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
                {card.next_due_kind ? `${timerLabel(card.next_due_kind)} · ` : ""}
                {relativeDay(due, today)}
              </Badge>
            ) : null}
            {priority ? <Stake priority={priority} /> : null}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {[card.contact_name, card.phone ? formatUS(card.phone) : "", card.industry]
              .filter(Boolean)
              .join(" · ")}
            {card.wanted_amount_cents ? (
              <span className="font-medium text-text-2 tabular-nums">
                {" "}
                · wants {formatMoneyCompact(card.wanted_amount_cents)}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {priority ? (
            <IconButton
              aria-pressed={hot}
              aria-label={hot ? `Unstar ${card.business_name}` : `Star ${card.business_name}`}
              title={hot ? "Starred: always on top" : "Star: always on top of Today"}
              onClick={() => void toggleHot(card.id, hot)}
              className={cn(hot && "text-warn hover:text-warn")}
            >
              <Icon name="star" filled={hot} />
            </IconButton>
          ) : null}
          {booked ? (
            // Snoozing can't move an appointment, so don't offer a button that appears to do nothing.
            <Link
              href={`/clients/${card.id}`}
              title="This merchant has a call booked today. Move or cancel the call on their page."
              className="inline-flex h-10 items-center rounded-lg px-2.5 text-[13px] font-medium text-accent transition hover:bg-surface-2 sm:h-8"
            >
              Move the call
            </Link>
          ) : (
            <SnoozeMenu card={card} />
          )}
        </div>
      </div>

      {card.last_call_at ? (
        <p className="mt-2 line-clamp-2 text-[13px]">
          <span className="text-muted">
            Last call {timeAgo(card.last_call_at, new Date(nowMs))}
            {card.last_call_note ? ": " : ""}
          </span>
          {card.last_call_note ? (
            <span className="text-text-2 italic">“{card.last_call_note}”</span>
          ) : null}
        </p>
      ) : (
        <p className="mt-2 text-[13px] text-muted">Never called.</p>
      )}

      <div className="mt-2.5">
        <ContactActions client={card} />
      </div>
    </article>
  );
});
