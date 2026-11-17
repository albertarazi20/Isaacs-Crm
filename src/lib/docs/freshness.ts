/**
 * Statement freshness. A file needs the newest complete months; one that was "complete" in October is stale by
 * mid-November. All dates are 'YYYY-MM-01' (the statement month) or 'YYYY-MM-DD' (today).
 */
import type { ISODate } from "../mca/dates";
import { monthName } from "./label";

/** How many complete months a file needs. */
export const WANTED_MONTHS = 4;
/** Banks post the statement a few days after month end; before this day the previous month is not expected yet. */
const STATEMENT_READY_DAY = 5;

export interface Freshness {
  /** The newest statement month on file, or null. */
  newest: ISODate | null;
  /** The newest month a file needs right now. */
  expected: ISODate;
  /** Months between newest and expected (0 = fresh). */
  monthsBehind: number;
  /** The months a file needs that are not on file, oldest first. */
  missing: ISODate[];
  /** One sentence for the rep. */
  message: string;
  status: "fresh" | "stale" | "none";
}

const monthStart = (y: number, m: number): ISODate => `${y}-${String(m).padStart(2, "0")}-01`;

function shiftMonth(period: ISODate, n: number): ISODate {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7)) - 1 + n;
  return monthStart(y + Math.floor(m / 12), (((m % 12) + 12) % 12) + 1);
}

/** The newest complete statement month a file needs on `today`. */
export function expectedMonth(today: ISODate): ISODate {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const d = Number(today.slice(8, 10));
  // before the 5th, last month's statement may not be out yet: the month before is the newest expected
  return shiftMonth(monthStart(y, m), d >= STATEMENT_READY_DAY ? -1 : -2);
}

export function freshness(
  periodsOnFile: readonly ISODate[],
  today: ISODate,
  wanted = WANTED_MONTHS,
): Freshness {
  const have = new Set(periodsOnFile.map((p) => p.slice(0, 7)));
  const expected = expectedMonth(today);
  const window: ISODate[] = [];
  for (let i = wanted - 1; i >= 0; i--) window.push(shiftMonth(expected, -i));
  const missing = window.filter((p) => !have.has(p.slice(0, 7)));
  const newest = [...have].sort().at(-1);
  const newestP = newest ? `${newest}-01` : null;
  if (!newestP) {
    return {
      newest: null,
      expected,
      monthsBehind: wanted,
      missing,
      message: `No statements yet. The file needs ${monthName(window[0]!)} through ${monthName(expected)}.`,
      status: "none",
    };
  }
  const behind = Math.max(
    0,
    (Number(expected.slice(0, 4)) - Number(newestP.slice(0, 4))) * 12 +
      (Number(expected.slice(5, 7)) - Number(newestP.slice(5, 7))),
  );
  if (behind === 0 && missing.length === 0) {
    return {
      newest: newestP,
      expected,
      monthsBehind: 0,
      missing,
      message: `Statements are current through ${monthName(newestP)}.`,
      status: "fresh",
    };
  }
  const message =
    behind > 0
      ? `Newest statement is ${monthName(newestP)}. The file needs ${monthName(expected)}.`
      : `Statements run through ${monthName(newestP)} but ${missing.map(monthName).join(", ")} ${missing.length === 1 ? "is" : "are"} missing.`;
  return { newest: newestP, expected, monthsBehind: behind, missing, message, status: "stale" };
}
