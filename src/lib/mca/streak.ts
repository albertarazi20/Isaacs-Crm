import { addDays, parseISODate, type ISODate } from "./dates";

/** How many follow-ups were still open, and due, when a day ended. */
export interface CloseOfDay {
  day: ISODate;
  open: number;
}

export interface Streak {
  /** Business days in a row, ending at the last finished one, with nothing left overdue at close. */
  current: number;
  /** The longest run in the data we looked at. */
  best: number;
  /** Open and due right now (due today or earlier) — what stands between today and a clean close. */
  openNow: number;
  /** Nothing to measure yet: no finished business day with follow-ups behind it. */
  empty: boolean;
}

const isWeekend = (day: ISODate): boolean => {
  const dow = parseISODate(day).getUTCDay();
  return dow === 0 || dow === 6;
};

/**
 * Weekends neither break nor extend a streak: a follow-up that falls due on Saturday is judged at Monday's
 * close, like everything else. Today is never counted — it isn't over. Days before the first follow-up ever
 * existed are not "clean", they're nothing, so callers pass only days from then on.
 */
export function buildStreak(days: readonly CloseOfDay[], today: ISODate, openNow: number): Streak {
  const done = days
    .filter((d) => d.day < today && !isWeekend(d.day))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  let best = 0;
  let run = 0;
  for (const d of done) {
    run = d.open === 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { current: run, best, openNow, empty: done.length === 0 };
}

/** The window the query covers: enough history for a best streak, bounded so it stays fast. */
export const STREAK_DAYS = 120;
export const streakStart = (today: ISODate): ISODate => addDays(today, -STREAK_DAYS);
