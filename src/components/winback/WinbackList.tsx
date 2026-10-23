"use client";

import Link from "next/link";
import { useState } from "react";
import { setFollowUpAction } from "@/app/actions";
import type { ISODate } from "@/lib/mca/dates";
import { addDays } from "@/lib/mca/dates";
import { formatDate, relativeDay, timeAgo } from "@/lib/format";
import { formatUS } from "@/lib/mca/phone";
import { stageDef } from "@/lib/mca/stages";
import { textCountMessage, textCountWarning } from "@/lib/messaging/textCounter";
import {
  moneyLine,
  winbackSuggestion,
  type CompactRow,
  type WinbackRow,
} from "@/lib/messaging/winback";
import { formatMoneyCompact } from "@/lib/money";
import { useApp } from "../app-context";
import { ContactActions } from "../ContactActions";
import { useCall } from "../overlay";
import { StageBadge } from "../StageBadge";
import { Badge, Button, EmptyState, SectionTitle } from "../ui";
import { useTextCount } from "./useTextCount";

/** "7 texts today", with a gentle warning once it gets long. Kept in this browser only. */
export function TextCounter() {
  const { today } = useApp();
  const n = useTextCount(today);
  const warning = textCountWarning(n);
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted" data-testid="text-counter">
        <span className="font-semibold text-text">{textCountMessage(n)}</span> · counted when you
        tap “I sent it”
      </p>
      {warning ? (
        <p role="note" className="rounded-lg bg-warn-soft p-3 text-sm text-warn">
          {warning}
        </p>
      ) : null}
    </div>
  );
}

function NotNow({ row, days }: { row: WinbackRow; days: number }) {
  const { today } = useApp();
  const call = useCall();
  const [busy, setBusy] = useState(false);
  // Just past the window being shown, so the merchant leaves this list and comes back on that date.
  const until: ISODate = addDays(today, days + 1);
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy}
      title={`Hide until ${formatDate(until, today)}`}
      onClick={async () => {
        setBusy(true);
        await call(
          setFollowUpAction({ clientId: row.card.id, dueOn: until }),
          `${row.card.business_name} — back on ${formatDate(until, today)}`,
        );
        setBusy(false);
      }}
    >
      Not now
    </Button>
  );
}

function Item({ row, days }: { row: WinbackRow; days: number }) {
  const { today, senderName, nowMs } = useApp();
  const { card } = row;
  const text = winbackSuggestion(row, senderName, today);
  const due = card.next_due_on;
  const money = moneyLine(row);
  return (
    <article className="space-y-2.5 rounded-xl border border-border bg-surface p-3.5">
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
              <Badge tone={due < today ? "bad" : due === today ? "warn" : "neutral"}>
                {relativeDay(due, today)}
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted">
            {[card.contact_name, card.phone ? formatUS(card.phone) : "", card.industry]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="text-sm">
            <span className="text-muted">
              {stageDef(card.stage).label} {timeAgo(card.stage_changed_at, new Date(nowMs))}
            </span>
            {money ? <span className="font-medium"> · {money}</span> : null}
          </p>
        </div>
      </div>
      <blockquote className="rounded-lg border-l-4 border-accent/60 bg-surface-2 px-3 py-2 text-sm">
        <span className="block text-xs font-medium text-muted">Suggested text</span>
        {text}
      </blockquote>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ContactActions client={card} suggestedText={text} />
        <NotNow row={row} days={days} />
      </div>
    </article>
  );
}

function Compact({ rows, empty }: { rows: CompactRow[]; empty?: string }) {
  const { today } = useApp();
  if (rows.length === 0) return empty ? <p className="text-sm text-muted">{empty}</p> : null;
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link
              href={`/clients/${r.id}`}
              className="font-medium hover:text-accent hover:underline"
            >
              {r.businessName}
            </Link>
            <StageBadge stage={r.stage} />
          </div>
          <span className="text-sm text-muted">
            {r.moneyCents > 0 ? `${formatMoneyCompact(r.moneyCents)} · ` : ""}
            {r.dueOn ? relativeDay(r.dueOn, today) : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function WinbackList({
  batch,
  later,
  laterCount,
  done,
  days,
}: {
  batch: WinbackRow[];
  later: CompactRow[];
  laterCount: number;
  done: CompactRow[];
  days: number;
}) {
  return (
    <div className="space-y-6">
      <TextCounter />
      <section className="space-y-2" aria-label="Win-back 10">
        <SectionTitle aside={<span className="text-sm text-muted">{batch.length} of 10</span>}>
          Win-back 10
        </SectionTitle>
        {batch.length === 0 ? (
          <EmptyState title="Nobody left to win back right now">
            {done.length > 0
              ? "You've worked everyone due in this window today."
              : `No dead, declined, lost or not-interested merchants are due in the next ${days} days. Try a longer window.`}
          </EmptyState>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {batch.map((r) => (
              <Item key={r.card.id} row={r} days={days} />
            ))}
          </div>
        )}
      </section>

      {laterCount > 0 ? (
        <details className="space-y-2">
          <summary className="cursor-pointer text-sm font-semibold tracking-wide text-muted uppercase">
            Up next after this batch ({laterCount})
          </summary>
          <div className="mt-2 space-y-2">
            <Compact rows={later} />
            {laterCount > later.length ? (
              <p className="text-sm text-muted">
                …and {laterCount - later.length} more. They slide up as you finish these.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}

      {done.length > 0 ? (
        <details className="space-y-2">
          <summary className="cursor-pointer text-sm font-semibold tracking-wide text-muted uppercase">
            Done today ({done.length})
          </summary>
          <div className="mt-2">
            <Compact rows={done} />
          </div>
        </details>
      ) : null}
    </div>
  );
}
