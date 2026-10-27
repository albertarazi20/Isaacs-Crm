"use client";

import { useMemo } from "react";
import { priorityOf, rankCards, type Priority, type SortMode } from "@/lib/data/priority";
import type { ClientCard } from "@/lib/data/types";
import { useApp } from "../app-context";
import { ClientRow } from "../ClientRow";
import { cn, SectionTitle } from "../ui";
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

  const rows = (items: { card: ClientCard; priority: Priority }[]) =>
    items.map(({ card, priority }) => (
      <ClientRow
        key={card.id}
        card={card}
        priority={priority}
        hot={hot.has(card.id)}
        snoozeCount={snoozeCounts[card.id] ?? 0}
      />
    ));

  return (
    <>
      {overdue.length + dueToday.length > 1 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div
            role="group"
            aria-label="Order of Overdue and Due today"
            className="inline-flex rounded-lg border border-border bg-surface p-0.5"
          >
            {MODES.map((m) => (
              <button
                key={m.mode}
                type="button"
                aria-pressed={mode === m.mode}
                onClick={() => setMode(m.mode)}
                className={cn(
                  "h-8 rounded-md px-3 text-sm font-medium transition",
                  mode === m.mode
                    ? "bg-accent text-accent-fg"
                    : "text-muted hover:bg-surface-2 hover:text-text",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <details className="text-sm text-muted">
            <summary className="cursor-pointer">How “biggest” is decided</summary>
            <p className="mt-1 max-w-xl">
              Dollars at stake (what he wants, or what funders would approve, or the payback still
              outstanding on a default) times how close the stage is to funding times a small bonus
              for every day overdue. A renewal call on an advance 50% paid down, or a default that
              promised to pay today, counts as high. A starred ★ client always goes first. Tap “at
              stake” on any row for its working.
            </p>
          </details>
        </div>
      ) : null}

      {lists.scheduled.length > 0 ? (
        <section className="space-y-2">
          <SectionTitle>Reminders today ({lists.scheduled.length})</SectionTitle>
          <div className="grid gap-3 xl:grid-cols-2">{rows(lists.scheduled)}</div>
        </section>
      ) : null}

      {lists.overdue.length > 0 ? (
        <section className="space-y-2">
          <SectionTitle aside={<BulkReschedule overdue={overdue} />}>
            <span className="text-bad">Overdue ({lists.overdue.length})</span>
          </SectionTitle>
          <div className="grid gap-3 xl:grid-cols-2">{rows(lists.overdue)}</div>
        </section>
      ) : null}

      {lists.dueToday.length > 0 ? (
        <section className="space-y-2">
          <SectionTitle>Due today ({lists.dueToday.length})</SectionTitle>
          <div className="grid gap-3 xl:grid-cols-2">{rows(lists.dueToday)}</div>
        </section>
      ) : null}

      {lists.upcoming.length > 0 ? (
        <details className="group space-y-2">
          <summary className="cursor-pointer text-sm font-semibold tracking-wide text-muted uppercase">
            Coming up in the next 7 days ({lists.upcoming.length})
          </summary>
          <div className="mt-2 grid gap-3 xl:grid-cols-2">{rows(lists.upcoming)}</div>
        </details>
      ) : null}
    </>
  );
}
