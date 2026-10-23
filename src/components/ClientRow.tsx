"use client";

import Link from "next/link";
import { memo, useState } from "react";
import { setFollowUpAction } from "@/app/actions";
import type { ClientCard } from "@/lib/data/types";
import { cardFundingTerms } from "@/lib/data/views";
import { formatDate, relativeDay, timeAgo } from "@/lib/format";
import { addDays, addMonths, type ISODate } from "@/lib/mca/dates";
import { balanceCents, paydownPct } from "@/lib/mca/funding";
import { formatUS } from "@/lib/mca/phone";
import { TIMER_LABELS } from "@/lib/mca/stages";
import { formatMoney, formatMoneyCompact } from "@/lib/money";
import { useApp } from "./app-context";
import { ContactActions } from "./ContactActions";
import { useCall } from "./overlay";
import { StageBadge } from "./StageBadge";
import { Badge, cn } from "./ui";

const SNOOZES: { label: string; to: (today: ISODate) => ISODate }[] = [
  { label: "Tomorrow", to: (t) => addDays(t, 1) },
  { label: "3 days", to: (t) => addDays(t, 3) },
  { label: "1 week", to: (t) => addDays(t, 7) },
  { label: "2 weeks", to: (t) => addDays(t, 14) },
  { label: "1 month", to: (t) => addMonths(t, 1) },
  { label: "3 months", to: (t) => addMonths(t, 3) },
  { label: "6 months", to: (t) => addMonths(t, 6) },
  { label: "12 months", to: (t) => addMonths(t, 12) },
];

function Snooze({ card }: { card: ClientCard }) {
  const { today } = useApp();
  const call = useCall();
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="relative">
      <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg px-2.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-text">
        Snooze ▾
      </summary>
      <div className="absolute right-0 z-20 mt-1 grid w-44 gap-0.5 rounded-xl border border-border bg-surface p-1 shadow-xl">
        {SNOOZES.map((s) => (
          <button
            key={s.label}
            type="button"
            className="rounded-lg px-3 py-1.5 text-left text-sm hover:bg-surface-2"
            onClick={async () => {
              const dueOn = s.to(today);
              setOpen(false);
              await call(
                setFollowUpAction({ clientId: card.id, dueOn }),
                `${card.business_name} — snoozed until ${formatDate(dueOn, today)}`,
              );
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </details>
  );
}

export const ClientRow = memo(function ClientRow({
  card,
  showPaydown = false,
}: {
  card: ClientCard;
  showPaydown?: boolean;
}) {
  const { today } = useApp();
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
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/clients/${card.id}`}
              className="text-base font-semibold hover:text-accent hover:underline"
            >
              {card.business_name}
            </Link>
            <StageBadge stage={card.stage} />
            {due ? (
              <Badge tone={overdue ? "bad" : isToday ? "warn" : "neutral"}>
                {card.next_due_kind ? `${TIMER_LABELS[card.next_due_kind]} · ` : ""}
                {relativeDay(due, today)}
              </Badge>
            ) : null}
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
        <Snooze card={card} />
      </div>

      {card.last_call_at ? (
        <p className="mt-2 line-clamp-2 text-sm">
          <span className="text-muted">
            Last call {timeAgo(card.last_call_at)}
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
            {formatMoney(terms.paymentCents)} {terms.frequency}
          </p>
        </div>
      ) : null}

      <div className="mt-3">
        <ContactActions client={card} />
      </div>
    </article>
  );
});
