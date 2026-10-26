import { addMonths, type ISODate } from "../mca/dates";
import type { AdvanceRow } from "./types";

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2026-10-23" → "2026-10". */
export const monthKey = (d: ISODate): string => d.slice(0, 7);

/** The month `delta` months from a "YYYY-MM" key. */
export function shiftMonth(key: string, delta: number): string {
  return monthKey(addMonths(`${key}-01`, delta));
}

/** "2026-10" → "Oct 2026" (or "Oct" when `short`). */
export function monthLabel(key: string, short = false): string {
  const name = MONTH_NAMES[Number(key.slice(5, 7)) - 1] ?? key;
  return short ? name : `${name} ${key.slice(0, 4)}`;
}

export interface EarnedSummary {
  thisMonthCents: number;
  lastMonthCents: number;
  ytdCents: number;
  thisMonthCount: number;
  lastMonthCount: number;
  ytdCount: number;
  /** Advances with any commission received on record — zero means the page has nothing to show yet. */
  entries: number;
}

/** Commission RECEIVED, by the day it arrived. Never expected money. */
export function earnedSummary(advances: readonly AdvanceRow[], today: ISODate): EarnedSummary {
  const thisMonth = monthKey(today);
  const lastMonth = shiftMonth(thisMonth, -1);
  const year = today.slice(0, 4);
  const s: EarnedSummary = {
    thisMonthCents: 0,
    lastMonthCents: 0,
    ytdCents: 0,
    thisMonthCount: 0,
    lastMonthCount: 0,
    ytdCount: 0,
    entries: 0,
  };
  for (const a of advances) {
    if (a.commissionReceivedCents === null || a.commissionReceivedOn === null) continue;
    s.entries += 1;
    const on = a.commissionReceivedOn;
    if (on.slice(0, 4) === year && on <= today) {
      s.ytdCents += a.commissionReceivedCents;
      s.ytdCount += 1;
    }
    if (monthKey(on) === thisMonth) {
      s.thisMonthCents += a.commissionReceivedCents;
      s.thisMonthCount += 1;
    } else if (monthKey(on) === lastMonth) {
      s.lastMonthCents += a.commissionReceivedCents;
      s.lastMonthCount += 1;
    }
  }
  return s;
}

export interface MonthRow {
  key: string;
  label: string;
  fundedCount: number;
  fundedCents: number;
  commissionCents: number;
  commissionCount: number;
}

/**
 * The last `months` calendar months, oldest first, including quiet ones (a gap in the chart is information).
 * Funded count and dollars land in the month of the funded date; commission lands in the month it was received.
 */
export function monthRows(
  advances: readonly AdvanceRow[],
  today: ISODate,
  months = 12,
): MonthRow[] {
  const thisMonth = monthKey(today);
  const rows = new Map<string, MonthRow>();
  for (let i = months - 1; i >= 0; i -= 1) {
    const key = shiftMonth(thisMonth, -i);
    rows.set(key, {
      key,
      label: monthLabel(key),
      fundedCount: 0,
      fundedCents: 0,
      commissionCents: 0,
      commissionCount: 0,
    });
  }
  for (const a of advances) {
    const funded = rows.get(monthKey(a.fundedOn));
    if (funded) {
      funded.fundedCount += 1;
      funded.fundedCents += a.amountCents;
    }
    if (a.commissionReceivedCents !== null && a.commissionReceivedOn !== null) {
      const got = rows.get(monthKey(a.commissionReceivedOn));
      if (got) {
        got.commissionCents += a.commissionReceivedCents;
        got.commissionCount += 1;
      }
    }
  }
  return [...rows.values()];
}
