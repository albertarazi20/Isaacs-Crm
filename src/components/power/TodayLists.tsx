"use client";

import { useMemo, useState, type ReactNode } from "react";
import { priorityOf, rankCards, type Priority, type SortMode } from "@/lib/data/priority";
import type { ClientCard } from "@/lib/data/types";
import { useApp } from "../app-context";
import { ClientRow } from "../ClientRow";
import { Glyph } from "../shell/icons";
import { Button, cn, TONE_TEXT, type Tone } from "../ui";
import { BulkReschedule } from "./BulkReschedule";
import { useHotIds, useSortMode } from "./prefs";

interface Props {
  scheduled: ClientCard[];
  overdue: ClientCard[];
  dueToday: ClientCard[];
  upcoming: ClientCard[];
  /** Pushes in the last 14 days, by client id. */
  snoozeCounts: Record<string, number>;
}

const MODES: { mode: SortMode; label: string }[] = [
  { mode: "oldest", label: "Oldest first" },
  { mode: "biggest", label: "Biggest first" },
];

/** Rows a section opens with; a long backlog unfolds on request instead of burying the sections under it. */
const FIRST = 12;

type Item = { card: ClientCard; priority: Priority };

/** One group of the queue: a titled panel of compact rows. */
function Group({
  title,
  hint,
  tone,
  items,
  aside,
  render,
  collapsed = false,
}: {
  title: string;
  hint: string;
  tone: Tone;
  items: Item[];
  aside?: ReactNode;
  render: (item: Item) => ReactNode;
  /** Starts folded (the days ahead): the header alone, one tap to open. */
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(!collapsed);
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, FIRST);
  return (
    <section className="rounded-2xl border border-border bg-surface">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:px-4">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="group/head -mx-1 flex min-h-9 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1 text-left transition duration-150 active:scale-[0.99]"
        >
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full bg-current", TONE_TEXT[tone])}
          />
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-text-2 tabular-nums">
            {items.length}
          </span>
          <span className="hidden truncate text-xs text-muted md:inline">{hint}</span>
          <Glyph
            name="chevronDown"
            className={cn(
              "ml-auto size-4 shrink-0 text-muted transition duration-200 group-hover/head:text-text",
              open && "rotate-180",
            )}
          />
        </button>
        {aside}
      </header>
      {open ? (
        <>
          <div className="divide-y divide-border border-t border-border">{shown.map(render)}</div>
          {items.length > FIRST ? (
            <div className="flex justify-center border-t border-border p-2">
              <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
                {all ? "Show fewer" : `Show all ${items.length}`}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** Today's sections. Overdue and Due today are ordered here, in the browser, so the toggle and the stars apply at once. */
export function TodayLists({ scheduled, overdue, dueToday, upcoming, snoozeCounts }: Props) {
  const { today, timezone } = useApp();
  const [mode, setMode] = useSortMode();
  const hot = useHotIds();
  const ctx = useMemo(() => ({ today, timezone, hotIds: hot }), [today, timezone, hot]);

  const lists = useMemo(() => {
    const plain = (cards: ClientCard[]) =>
      cards.map((card) => ({ card, priority: priorityOf(card, ctx) }));
    return {
      scheduled: plain(scheduled),
      upcoming: plain(upcoming),
      overdue: rankCards(overdue, ctx, mode),
      dueToday: rankCards(dueToday, ctx, mode),
    };
  }, [scheduled, upcoming, overdue, dueToday, ctx, mode]);

  const row = ({ card, priority }: Item) => (
    <ClientRow
      key={card.id}
      card={card}
      priority={priority}
      hot={hot.has(card.id)}
      snoozeCount={snoozeCounts[card.id] ?? 0}
    />
  );

  return (
    <div className="space-y-4">
      {overdue.length + dueToday.length > 1 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div
            role="group"
            aria-label="Order of Overdue and Due today"
            className="inline-flex gap-0.5 rounded-full border border-border bg-surface-2/70 p-1"
          >
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                aria-pressed={mode === m.mode}
                onClick={() => setMode(m.mode)}
                className={cn(
                  "h-9 rounded-full px-3.5 text-[13px] font-medium transition duration-150 active:scale-[0.97] sm:h-8",
                  mode === m.mode
                    ? "bg-surface text-text shadow-card"
                    : "text-muted hover:bg-surface/60 hover:text-text",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <details className="group text-xs text-muted">
            <summary className="flex min-h-9 cursor-pointer list-none items-center gap-1 select-none hover:text-text sm:min-h-8 [&::-webkit-details-marker]:hidden">
              How “biggest” is decided
              <Glyph
                name="chevronDown"
                className="size-3.5 transition duration-150 group-open:rotate-180"
              />
            </summary>
            <p className="mt-1 max-w-xl text-[13px] text-text-2">
              Dollars at stake (what he wants) times how close the file is to complete times a small
              bonus for every day overdue. A starred merchant always goes first. Tap “at stake” on
              any row for its working.
            </p>
          </details>
        </div>
      ) : null}

      <Group
        title="Reminders today"
        hint="Booked for a time. Keep the appointment."
        tone="accent"
        items={lists.scheduled}
        render={row}
      />
      <Group
        title="Overdue"
        hint="Past their date. Clear these first."
        tone="warn"
        items={lists.overdue}
        aside={<BulkReschedule overdue={overdue} />}
        render={row}
      />
      <Group
        title="Due today"
        hint="On schedule if you reach them today."
        tone="info"
        items={lists.dueToday}
        render={row}
      />
      <Group
        title="Later this week"
        hint="Coming up in the next 7 days."
        tone="neutral"
        items={lists.upcoming}
        render={row}
        collapsed
      />
    </div>
  );
}
