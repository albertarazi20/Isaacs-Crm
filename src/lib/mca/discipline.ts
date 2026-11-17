import type { ISODate } from "./dates";

export interface TimerHistory {
  dueOn: ISODate;
  /** The day, in the user's time zone, the timer was closed; null while still open. */
  doneOn: ISODate | null;
  doneReason: "completed" | "replaced" | "stage_moved" | "cancelled" | null;
}

export interface Discipline {
  total: number;
  /** Done on or before its due day. */
  onTime: number;
  /** Done, but after its due day. */
  late: number;
  /** Pushed to a later date instead of being done (snoozed). */
  pushed: number;
  /** Past due and still open today. */
  overdue: number;
  /** onTime as a share of total, 0–100; null when nothing came due. */
  onTimeRate: number | null;
}

/**
 * How well the follow-ups that CAME DUE were handled. Timers still in the future, due today, or cancelled
 * on purpose (do-not-contact, trash, a call that was called off) are not counted either way.
 */
export function buildDiscipline(timers: readonly TimerHistory[], today: ISODate): Discipline {
  const d: Discipline = {
    total: 0,
    onTime: 0,
    late: 0,
    pushed: 0,
    overdue: 0,
    onTimeRate: null,
  };
  for (const t of timers) {
    if (t.dueOn > today) continue;
    if (t.doneOn === null) {
      if (t.dueOn === today) continue;
      d.overdue += 1;
    } else if (t.doneReason === "completed" || t.doneReason === "stage_moved") {
      // Moving the merchant to another stage handles the follow-up too: it sets the next timer.
      if (t.doneOn <= t.dueOn) d.onTime += 1;
      else d.late += 1;
    } else if (t.doneReason === "replaced") d.pushed += 1;
    else continue;
    d.total += 1;
  }
  d.onTimeRate = d.total === 0 ? null : pct(d.onTime, d.total);
  return d;
}

function pct(n: number, of: number): number {
  return of === 0 ? 0 : Math.round((n / of) * 1000) / 10;
}
