/** Calendar dates are plain "YYYY-MM-DD" strings. All math is UTC so no timezone can shift a day. */
export type ISODate = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toISODate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function parseISODate(s: ISODate): Date {
  const m = DATE_RE.exec(s);
  if (!m) throw new Error(`bad date: ${s}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (toISODate(d) !== s) throw new Error(`bad date: ${s}`);
  return d;
}

/** A YYYY-MM-DD that is a day on the calendar: 2026-02-30 and 2026-13-01 are not. */
export function isRealDate(s: string): boolean {
  try {
    parseISODate(s);
    return true;
  } catch {
    return false;
  }
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = parseISODate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

/** Jan 31 + 1 month = Feb 28/29, never Mar 3. */
export function addMonths(s: ISODate, n: number): ISODate {
  const d = parseISODate(s);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return toISODate(d);
}

export function diffDays(from: ISODate, to: ISODate): number {
  return Math.round((parseISODate(to).getTime() - parseISODate(from).getTime()) / 86_400_000);
}

function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/** Mon–Fri. Funders debit on business days; holidays are ignored on purpose. */
export function addBusinessDays(s: ISODate, n: number): ISODate {
  const d = parseISODate(s);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d)) left -= 1;
  }
  return toISODate(d);
}

/** Business days in the half-open range (from, to]. */
export function businessDaysBetween(from: ISODate, to: ISODate): number {
  const total = diffDays(from, to);
  if (total <= 0) return 0;
  const d = parseISODate(from);
  let count = 0;
  for (let i = 0; i < total; i += 1) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d)) count += 1;
  }
  return count;
}

export function todayIn(tz: string, now: Date = new Date()): ISODate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export type PresetKey =
  "1w" | "2w" | "1m" | "2m" | "3m" | "6m" | "9m" | "12m" | "18m" | "24m" | "36m";

export interface Preset {
  key: PresetKey;
  label: string;
  days?: number;
  months?: number;
}

/** Timers run out to 36 months — a dead lead is still a lead. */
export const FOLLOW_UP_PRESETS: readonly Preset[] = [
  { key: "1w", label: "1 week", days: 7 },
  { key: "2w", label: "2 weeks", days: 14 },
  { key: "1m", label: "1 month", months: 1 },
  { key: "2m", label: "2 months", months: 2 },
  { key: "3m", label: "3 months", months: 3 },
  { key: "6m", label: "6 months", months: 6 },
  { key: "9m", label: "9 months", months: 9 },
  { key: "12m", label: "12 months", months: 12 },
  { key: "18m", label: "18 months", months: 18 },
  { key: "24m", label: "24 months", months: 24 },
  { key: "36m", label: "36 months", months: 36 },
];

export const MAX_FOLLOW_UP_MONTHS = 36;

export function presetByKey(key: PresetKey): Preset {
  const p = FOLLOW_UP_PRESETS.find((x) => x.key === key);
  if (!p) throw new Error(`unknown preset: ${key}`);
  return p;
}

export function dueFromPreset(key: PresetKey, from: ISODate): ISODate {
  const p = presetByKey(key);
  return p.months !== undefined ? addMonths(from, p.months) : addDays(from, p.days ?? 0);
}

/** A custom date is allowed up to 36 months out and never in the past. */
export function validateFollowUpDate(dueOn: ISODate, today: ISODate): string | null {
  parseISODate(dueOn);
  if (dueOn < today) return "Follow-up date is in the past";
  if (dueOn > addMonths(today, MAX_FOLLOW_UP_MONTHS))
    return "Follow-up date is more than 36 months out";
  return null;
}

export type BucketKey = "overdue" | "today" | PresetKey | "later";

export const BUCKET_ORDER: readonly BucketKey[] = [
  "overdue",
  "today",
  ...FOLLOW_UP_PRESETS.map((p) => p.key),
  "later",
];

/** Which follow-up column a due date lands in. Smallest bucket whose date is on/after dueOn. */
export function bucketFor(dueOn: ISODate, today: ISODate): BucketKey {
  if (dueOn < today) return "overdue";
  if (dueOn === today) return "today";
  for (const key of BUCKET_ORDER) {
    if (key === "overdue" || key === "today" || key === "later") continue;
    if (dueOn <= dueFromPreset(key, today)) return key;
  }
  return "later";
}

export function bucketLabel(key: BucketKey): string {
  if (key === "overdue") return "Overdue";
  if (key === "today") return "Today";
  if (key === "later") return "Later (36 mo+)";
  return presetByKey(key).label;
}

/** Everything parked more than a year out lives in the Long Game view. */
export function isLongGame(dueOn: ISODate, today: ISODate): boolean {
  return dueOn > addMonths(today, 12);
}
