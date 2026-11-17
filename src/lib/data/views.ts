import { addDays, type ISODate } from "../mca/dates";
import { bookedToday } from "../mca/booked";
import { stageDef, type StageGroup, type TimerKind } from "../mca/stages";
import type { ClientCard } from "./types";

const KIND_RANK: Record<TimerKind, number> = {
  scheduled_call: 0,
  follow_up: 1,
};
// Merchants whose application is in first (their documents are what is left), then the rest.
const GROUP_RANK: Record<StageGroup, number> = {
  application: 0,
  prospecting: 1,
  exit: 2,
};

function byPriority(a: ClientCard, b: ClientCard): number {
  const ka = KIND_RANK[a.next_due_kind ?? "follow_up"];
  const kb = KIND_RANK[b.next_due_kind ?? "follow_up"];
  if (ka !== kb) return ka - kb;
  if (a.next_due_kind === "scheduled_call" && a.scheduled_call_at && b.scheduled_call_at) {
    return a.scheduled_call_at.localeCompare(b.scheduled_call_at);
  }
  const ga = GROUP_RANK[stageDef(a.stage).group];
  const gb = GROUP_RANK[stageDef(b.stage).group];
  return ga - gb || a.business_name.localeCompare(b.business_name);
}

export interface TodayView {
  /** Calls booked for today, earliest first. */
  scheduled: ClientCard[];
  /** Oldest first — the longer it waits, the more it costs. */
  overdue: ClientCard[];
  dueToday: ClientCard[];
  /** Tomorrow through 7 days out. */
  upcoming: ClientCard[];
  kpis: {
    overdue: number;
    dueToday: number;
    next7: number;
  };
}

export function buildToday(
  cards: readonly ClientCard[],
  today: ISODate,
  timezone = "UTC",
): TodayView {
  // A do-not-contact merchant is never on the call list, however their timer reads.
  const due = cards.filter(
    (c): c is ClientCard & { next_due_on: ISODate } =>
      c.next_due_on !== null && c.contact_status !== "dnc",
  );
  // The booking decides, not the earliest timer: an older follow-up must not hide today's appointment.
  const booked = (c: ClientCard) => bookedToday(c, today, timezone);
  const scheduled = due
    .filter(booked)
    .sort(
      (a, b) =>
        (a.scheduled_call_at ?? "").localeCompare(b.scheduled_call_at ?? "") || byPriority(a, b),
    );
  const overdue = due
    .filter((c) => c.next_due_on < today && !booked(c))
    .sort((a, b) => a.next_due_on.localeCompare(b.next_due_on) || byPriority(a, b));
  const dueToday = due.filter((c) => c.next_due_on === today && !booked(c)).sort(byPriority);
  const weekOut = addDays(today, 7);
  const upcoming = due
    .filter((c) => c.next_due_on > today && c.next_due_on <= weekOut && !booked(c))
    .sort((a, b) => a.next_due_on.localeCompare(b.next_due_on) || byPriority(a, b));

  return {
    scheduled,
    overdue,
    dueToday,
    upcoming,
    kpis: {
      overdue: overdue.length,
      dueToday: dueToday.length + scheduled.length,
      next7: upcoming.length,
    },
  };
}
