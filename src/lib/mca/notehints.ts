import { formatDate } from "../format";
import {
  addBusinessDays,
  addDays,
  addMonths,
  MAX_FOLLOW_UP_MONTHS,
  parseISODate,
  toISODate,
  type ISODate,
} from "./dates";
import { stageDef, type StageKey } from "./stages";

/**
 * Notes → next date. Isaac writes "call Friday" or "after tax season" in a note and then has to pick a
 * follow-up date by hand. This reads the note with plain rules (no network, no AI) and offers dates as
 * one-tap chips. Nothing is ever applied by itself.
 *
 * Rules of the road:
 *  - Deterministic: the same note and the same `today` always give the same answer.
 *  - Never invents a date. A note with no date and no sign of a call-back returns nothing. A note that says
 *    "call back after he talks to his dispatcher" has a call-back but no date, so it gets ONE suggestion that
 *    says plainly it is the stage's usual pace.
 *  - Every suggestion is today or later, at most 36 months out, and lands on a business day (a Saturday or
 *    Sunday rolls to Monday; "today" is never moved).
 *  - A date that reads as the past ("called him Friday", "last Friday", "applied 10/15") is ignored.
 */

export interface DateHint {
  dueOn: ISODate;
  /** What the chip says: "Friday Oct 30". */
  label: string;
  /** Why it is suggested, quoting the note. */
  reason: string;
}

export interface NoteHints {
  suggestions: DateHint[];
  /** The note says he wants this fast (ASAP, urgent, hot, "needs it today"). */
  hot: boolean;
}

export const MAX_HINTS = 3;

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

// ---------------------------------------------------------------------------------------------
// calendar helpers (all UTC, string dates)

function parts(d: ISODate): { y: number; m: number; d: number } {
  const [y = 0, m = 0, day = 0] = d.split("-").map(Number);
  return { y, m, d: day };
}

function makeDate(y: number, m: number, d: number): ISODate | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return toISODate(dt);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The 31st in a 30-day month is the 30th. */
function clampDate(y: number, m: number, d: number): ISODate {
  return (
    makeDate(y, m, Math.min(d, daysInMonth(y, m))) ?? toISODate(new Date(Date.UTC(y, m - 1, 1)))
  );
}

/** (y, m) shifted by n months, m in 1..12. */
function shiftMonth(y: number, m: number, n: number): { y: number; m: number } {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

const dow = (d: ISODate): number => parseISODate(d).getUTCDay();
const isWeekend = (d: ISODate): boolean => dow(d) === 0 || dow(d) === 6;

function rollForward(d: ISODate): ISODate {
  const w = dow(d);
  return w === 6 ? addDays(d, 2) : w === 0 ? addDays(d, 1) : d;
}

function rollBack(d: ISODate): ISODate {
  const w = dow(d);
  return w === 6 ? addDays(d, -1) : w === 0 ? addDays(d, -2) : d;
}

/** The first business day of a month; nobody wants a follow-up on New Year's Day, so January starts on the 2nd. */
const firstBizDay = (y: number, m: number): ISODate =>
  rollForward(clampDate(y, m, m === 1 ? 2 : 1));
const lastBizDay = (y: number, m: number): ISODate => rollBack(clampDate(y, m, 31));

/** The next date after `today` (strictly) that falls on weekday `wd` (0 = Sunday). */
function nextWeekday(today: ISODate, wd: number): ISODate {
  const diff = (wd - dow(today) + 7) % 7;
  return addDays(today, diff === 0 ? 7 : diff);
}

/** Monday of the calendar week after this one. */
function startOfNextWeek(today: ISODate): ISODate {
  const w = dow(today);
  return addDays(today, w === 0 ? 1 : 8 - w);
}

function quarterStartMonth(m: number): number {
  return Math.floor((m - 1) / 3) * 3 + 1;
}

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const MONTH_INDEX: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const WD =
  "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|saturday|sunday)";
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

// ---------------------------------------------------------------------------------------------
// reading the text

interface Found {
  start: number;
  end: number;
  dueOn: ISODate;
  matched: string;
  /** Extra words for the reason ("Saturday isn't a business day — Monday instead"). */
  why?: string;
}

interface Ctx {
  /** The note with money, phone numbers and "Mon-Fri" blanked out (same length, so indexes line up). */
  text: string;
  today: ISODate;
}

/** Blank out text that looks like a date but isn't: phone numbers, amounts, "Mon–Fri", percentages. */
function clean(note: string): string {
  // "#" rather than spaces, so "about 80k a month" can't be read as "about a month".
  const blank = (s: string) => "#".repeat(s.length);
  return note
    .replace(/\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, blank)
    .replace(/\$\s?\d[\d,]*(?:\.\d+)?\s*[km]?\b/gi, blank)
    .replace(/\b\d+(?:\.\d+)?\s*k\b/gi, blank)
    .replace(/\b\d+(?:\.\d+)?\s*%/g, blank)
    .replace(
      /\b(?:mon(?:day)?|m)\s*(?:-|–|—|to|through|thru)\s*(?:fri(?:day)?|f|sat(?:urday)?)\b/gi,
      blank,
    )
    .replace(/\bweekdays\b/gi, blank);
}

const PAST_VERB =
  /\b(?:called|spoke|talked|texted|emailed|e-mailed|sent|met|saw|funded|signed|applied|declined|submitted|received|got|left|reached|tried|visited|dropped|closed|opened|was|were|had|did|missed|paid|started|began|ended|expired)\b/i;
const FUTURE_CUE =
  /\b(?:call|text|email|e-mail|follow(?:[\s-]?up)?|ping|reach|try|check|touch|circle|revisit|remind|talk|speak|chat|catch|connect|wait|hold|push|schedule|book|set|will|won't|gonna|going|plans?|planning|should|let's|lets|next|after|until|till|callback|back|\w+'ll)\b/i;
/** A clause is a run of words with no comma, period or dash in it; "Called him Friday, call back Tuesday" has two. */
const CLAUSE_BREAK = /[.;!?\n,]|\s[-–—]\s|\b(?:but|and then|then)\b/gi;

function clauseBefore(text: string, index: number): string {
  const head = text.slice(0, index);
  let cut = 0;
  for (const m of head.matchAll(CLAUSE_BREAK)) cut = (m.index ?? 0) + m[0].length;
  return head.slice(cut);
}

/** "Called him Friday" / "last Friday" / "2 weeks ago" read as the past, not as a plan. */
function readsAsPast(text: string, start: number, end: number): boolean {
  if (
    /\b(?:last|since|previous|prior|past|ago)\s*$/i.test(text.slice(Math.max(0, start - 12), start))
  )
    return true;
  if (/^\s*(?:ago|back then)\b/i.test(text.slice(end, end + 12))) return true;
  const clause = clauseBefore(text, start);
  return PAST_VERB.test(clause) && !FUTURE_CUE.test(clause);
}

function hasFutureCue(text: string, start: number): boolean {
  return FUTURE_CUE.test(clauseBefore(text, start));
}

// ---------------------------------------------------------------------------------------------
// matchers — each returns candidate dates with the span of text they came from

type Matcher = (c: Ctx) => Found[];

function found(m: RegExpMatchArray, dueOn: ISODate | null, why?: string): Found[] {
  if (dueOn === null || m.index === undefined) return [];
  return [{ start: m.index, end: m.index + m[0].length, dueOn, matched: m[0].trim(), why }];
}

/** Move a weekend date to Monday and say so. "Today" is never moved. */
function businessDay(dueOn: ISODate, today: ISODate): { dueOn: ISODate; why?: string } {
  if (dueOn === today || !isWeekend(dueOn)) return { dueOn };
  const name = WEEKDAY_NAMES[dow(dueOn)];
  return { dueOn: rollForward(dueOn), why: `${formatDate(dueOn, today)} is a ${name}, so Monday` };
}

function foundBiz(m: RegExpMatchArray, raw: ISODate | null, today: ISODate): Found[] {
  if (raw === null) return [];
  const b = businessDay(raw, today);
  return found(m, b.dueOn, b.why);
}

const isoMatcher: Matcher = ({ text, today }) =>
  [...text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)].flatMap((m) =>
    foundBiz(m, makeDate(Number(m[1]), Number(m[2]), Number(m[3])), today),
  );

/**
 * A month and day with no year: the next one coming, unless it just went by (then the note is talking about the
 * past). Feb 29 finds the next leap year.
 */
function nextYearless(month: number, day: number, today: ISODate): ISODate | null {
  const t = parts(today);
  const thisYear = makeDate(t.y, month, day);
  if (thisYear !== null && thisYear < today) {
    const ago = Math.round(
      (parseISODate(today).getTime() - parseISODate(thisYear).getTime()) / 86_400_000,
    );
    if (ago <= 31) return null;
  }
  for (let y = t.y; y <= t.y + 4; y += 1) {
    const d = makeDate(y, month, day);
    if (d !== null && d >= today) return d;
  }
  return null;
}

function withYear(
  month: number,
  day: number,
  yearRaw: string | undefined,
  today: ISODate,
): ISODate | null {
  if (!yearRaw) return nextYearless(month, day, today);
  const y = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
  return makeDate(y, month, day);
}

const monthDayMatcher: Matcher = ({ text, today }) => {
  const out: Found[] = [];
  const re1 = new RegExp(
    `\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b(?!\\s*(?:years?|yrs?|months?|days?|weeks?|%|k\\b|percent|trucks?))`,
    "gi",
  );
  for (const m of text.matchAll(re1)) {
    const month = MONTH_INDEX[(m[1] ?? "").toLowerCase()];
    if (month === undefined) continue;
    // "may" is also a verb: only "May 5" with a real day number counts.
    out.push(...foundBiz(m, withYear(month, Number(m[2]), m[3], today), today));
  }
  const re2 = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\b(?:,?\\s+(\\d{4}))?`,
    "gi",
  );
  for (const m of text.matchAll(re2)) {
    const month = MONTH_INDEX[(m[2] ?? "").toLowerCase()];
    // "5 may" reads as a date only with the ordinal or the word "of" ("5th of May"); "2 march" is a stretch too.
    if (month === undefined || !/(?:st|nd|rd|th)|\bof\b/i.test(m[0])) continue;
    out.push(...foundBiz(m, withYear(month, Number(m[1]), m[3], today), today));
  }
  return out;
};

const FRACTION_AFTER =
  /^\s*(?:paid|down|owner|ownership|split|share|stake|percent|%|off|point|points|revenue|payback|paying|way|through|done|of the|of his|of her)\b/i;
const DATE_CUE =
  /\b(?:on|by|until|till|after|before|around|about|or|call|text|email|back|follow(?:[\s-]?up)?|next|for|thru|through|at|is|set|due)\s*[:=]?\s*$/i;

const numericMatcher: Matcher = ({ text, today }) => {
  const out: Found[] = [];
  for (const m of text.matchAll(
    /(?<![\d/$.\-])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g,
  )) {
    const start = m.index ?? 0;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    if (FRACTION_AFTER.test(text.slice(start + m[0].length, start + m[0].length + 14))) continue;
    // "3/4 of the revenue" is a fraction. Without a year, only a date cue in front (or a day over 12) makes it a date.
    const cue = DATE_CUE.test(text.slice(Math.max(0, start - 24), start));
    if (!m[3] && !cue && day <= 12) continue;
    out.push(...foundBiz(m, withYear(month, day, m[3], today), today));
  }
  return out;
};

/** "the 15th", "after the 15th", "by the 20th", "on the 1st of next month". Ordinals followed by "position" are not dates. */
const dayOfMonthMatcher: Matcher = ({ text, today }) => {
  const out: Found[] = [];
  const re = new RegExp(
    `\\b(?:(after|past|by|before|until|till|around|about|on|near)\\s+)?(the\\s+)?(\\d{1,2})(?:st|nd|rd|th)\\b(\\s+of\\s+(next|this|the)\\s+month)?(?!\\s+(?:position|pos\\b|advance|lien|mortgage|place|quarter|time|round|try|attempt|funder|offer|batch|call|text|email|month|week|day|year|of\\s+${MONTH}\\b))`,
    "gi",
  );
  for (const m of text.matchAll(re)) {
    const prep = (m[1] ?? "").toLowerCase();
    if (!prep && !m[2]) continue;
    const n = Number(m[3]);
    if (n < 1 || n > 31) continue;
    const after = prep === "after" || prep === "past";
    const t = parts(today);
    let target: ISODate | null = null;
    const monthsAhead =
      m[5]?.toLowerCase() === "next" ? 1 : m[5]?.toLowerCase() === "this" ? 0 : null;
    if (monthsAhead !== null) {
      const s = shiftMonth(t.y, t.m, monthsAhead);
      const d = clampDate(s.y, s.m, n);
      target = after ? addDays(d, 1) : d;
    } else {
      for (let i = 0; i < 26 && target === null; i += 1) {
        const s = shiftMonth(t.y, t.m, i);
        const d = clampDate(s.y, s.m, n);
        const cand = after ? addDays(d, 1) : d;
        if (cand >= today) target = cand;
      }
    }
    out.push(...foundBiz(m, target, today));
  }
  return out;
};

/** "Friday", "on Friday", "this Friday", "next Tuesday", "after Friday". */
const weekdayMatcher: Matcher = ({ text, today }) => {
  const out: Found[] = [];
  const re = new RegExp(
    `\\b(?:(next|this|coming|upcoming|following|after|by|until|till|around|on)\\s+)?(${WD})\\b(?!\\s*(?:-|–|through|thru|to)\\s*${WD})`,
    "gi",
  );
  for (const m of text.matchAll(re)) {
    const wd = WEEKDAY_INDEX[(m[2] ?? "").toLowerCase()];
    if (wd === undefined) continue;
    const prep = (m[1] ?? "").toLowerCase();
    let target: ISODate;
    if (prep === "next") {
      const monday = startOfNextWeek(today);
      target = addDays(monday, (wd + 6) % 7);
    } else if (prep === "after") {
      target = rollForward(addDays(nextWeekday(today, wd), 1));
    } else {
      target = nextWeekday(today, wd);
    }
    out.push(...foundBiz(m, target, today));
  }
  return out;
};

const dayWordsMatcher: Matcher = ({ text, today }) => {
  const out: Found[] = [];
  // Tomorrow, "in the morning", "first thing": the next business day.
  const tomorrow =
    /\b(?:first thing(?:\s+(?:tomorrow|in the morning))?|bright and early|tomorrow(?:\s+(?:morning|afternoon|evening|am|pm))?|in the (?:morning|a\.?m\.?)|next morning)/gi;
  for (const m of text.matchAll(tomorrow)) {
    out.push(...foundBiz(m, addDays(today, 1), today));
  }
  // "call him today", "try again tonight": today, but only when a call-back is in the same breath.
  for (const m of text.matchAll(
    /\b(?:later today|this (?:morning|afternoon|evening)|tonight|today)\b/gi,
  )) {
    if (!hasFutureCue(text, m.index ?? 0)) continue;
    out.push(...found(m, today));
  }
  // "call back in an hour": today.
  for (const m of text.matchAll(
    /\b(?:in|within|after)\s+(?:\d+|an?|a few|a couple(?: of)?)\s*(?:hours?|hrs?|minutes?|mins?)\b/gi,
  )) {
    if (!hasFutureCue(text, m.index ?? 0)) continue;
    out.push(...found(m, today));
  }
  // After the weekend / over the weekend: Monday.
  for (const m of text.matchAll(/\b(?:after|over|past) (?:the|this) weekend\b/gi)) {
    out.push(...foundBiz(m, nextWeekday(today, 1), today));
  }
  return out;
};

const relativeSpanMatcher: Matcher = ({ text, today }) => {
  const out: Found[] = [];
  const num = "\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";
  const unit =
    "business\\s+days?|working\\s+days?|bdays?|days?|weeks?|wks?|months?|mos?|years?|yrs?";
  const re = new RegExp(
    `\\b(?:(in|within|after|about|around|another|give\\s+(?:him|her|them))\\s+)?(?:(${num})|((?:a\\s+)?(?:couple|few))(?:\\s+of)?)(?:\\s*(?:-|to)\\s*\\d+)?\\s*(${unit})\\b(?!\\s+(?:of|ago|old|in business))`,
    "gi",
  );
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    const prep = m[1];
    // Without "in"/"after"/…, "6 months" could be anything (six months of statements): need a call-back in the clause.
    if (!prep && !hasFutureCue(text, start)) continue;
    const word = (m[2] ?? "").toLowerCase();
    const fuzzy = (m[3] ?? "").toLowerCase();
    const n = fuzzy
      ? fuzzy.endsWith("couple")
        ? 2
        : 3
      : /^\d+$/.test(word)
        ? Number(word)
        : NUMBER_WORDS[word];
    if (n === undefined || n < 1 || n > 120) continue;
    // A bare "a" before a unit only means one when a preposition is there ("in a week"), never "a day" mid-sentence.
    if ((word === "a" || word === "an") && !prep) continue;
    const u = (m[4] ?? "").toLowerCase();
    let raw: ISODate;
    if (/^(?:business|working|bday)/.test(u)) {
      raw = addBusinessDays(today, n);
    } else if (u.startsWith("d")) {
      raw = addDays(today, n);
    } else if (u.startsWith("w")) {
      raw = addDays(today, 7 * n);
    } else if (u.startsWith("m")) {
      raw = addMonths(today, n);
    } else {
      raw = addMonths(today, 12 * n);
    }
    const b = businessDay(raw, today);
    out.push(...found(m, b.dueOn, b.why));
  }
  return out;
};

/** "next week", "end of the month", "next quarter", "mid-month", "end of the year", "end of next week". */
const periodMatcher: Matcher = ({ text, today }) => {
  const out: Found[] = [];
  const t = parts(today);
  const cur = { y: t.y, m: t.m };

  for (const m of text.matchAll(/\b(?:(early|mid|late|end of|the end of)[\s-]+)?next week\b/gi)) {
    const q = (m[1] ?? "").toLowerCase();
    const monday = startOfNextWeek(today);
    const target =
      q.includes("end") || q === "late"
        ? addDays(monday, 4)
        : q === "mid"
          ? addDays(monday, 2)
          : monday;
    out.push(...foundBiz(m, target, today));
  }
  for (const m of text.matchAll(
    /\b(?:end of (?:the |this )?week|eow|by the end of the week|friday of this week)\b/gi,
  )) {
    out.push(...foundBiz(m, nextWeekday(today, 5), today));
  }

  for (const m of text.matchAll(
    /\b(?:(early|mid|late|end of|the end of|beginning of|start of)[\s-]+)?next month\b/gi,
  )) {
    const q = (m[1] ?? "").toLowerCase();
    const s = shiftMonth(cur.y, cur.m, 1);
    const target = q.includes("end")
      ? lastBizDay(s.y, s.m)
      : q === "mid"
        ? clampDate(s.y, s.m, 15)
        : q === "late"
          ? clampDate(s.y, s.m, 25)
          : firstBizDay(s.y, s.m);
    out.push(...foundBiz(m, target, today));
  }
  for (const m of text.matchAll(
    /\b(?:end of (?:the |this )?month|eom|month[- ]end|the end of the month)\b/gi,
  )) {
    let d = lastBizDay(cur.y, cur.m);
    if (d < today) {
      const s = shiftMonth(cur.y, cur.m, 1);
      d = lastBizDay(s.y, s.m);
    }
    out.push(...found(m, d));
  }
  for (const m of text.matchAll(/\b(?:mid[- ]?month|middle of the month|mid of the month)\b/gi)) {
    let d = clampDate(cur.y, cur.m, 15);
    if (d < today) {
      const s = shiftMonth(cur.y, cur.m, 1);
      d = clampDate(s.y, s.m, 15);
    }
    out.push(...foundBiz(m, d, today));
  }
  for (const m of text.matchAll(
    /\b(?:(?:the )?(?:first|1st) of (?:the |next )?month|(?:beginning|start) of the month)\b/gi,
  )) {
    const s = shiftMonth(cur.y, cur.m, 1);
    out.push(...foundBiz(m, clampDate(s.y, s.m, 1), today));
  }

  for (const m of text.matchAll(/\bnext quarter\b/gi)) {
    const qm = shiftMonth(cur.y, quarterStartMonth(cur.m), 3);
    out.push(...foundBiz(m, firstBizDay(qm.y, qm.m), today));
  }
  for (const m of text.matchAll(/\b(?:end of (?:the |this )?quarter|eoq)\b/gi)) {
    const qs = quarterStartMonth(cur.m);
    const end = shiftMonth(cur.y, qs, 2);
    let d = lastBizDay(end.y, end.m);
    if (d < today) {
      const nx = shiftMonth(cur.y, qs, 5);
      d = lastBizDay(nx.y, nx.m);
    }
    out.push(...found(m, d));
  }

  for (const m of text.matchAll(/\b(?:end of (?:the |this )?year|eoy|year[- ]end)\b/gi)) {
    let d = lastBizDay(cur.y, 12);
    if (d < today) d = lastBizDay(cur.y + 1, 12);
    out.push(...found(m, d));
  }
  for (const m of text.matchAll(/\bnext year\b/gi)) {
    out.push(...foundBiz(m, makeDate(cur.y + 1, 1, 5), today));
  }
  // The holidays are over by the first week of January.
  for (const m of text.matchAll(
    /\bafter (?:the )?(?:holidays?|new year(?:'?s)?(?: day)?|first of the year)\b/gi,
  )) {
    let d = rollForward(clampDate(cur.y, 1, 5));
    if (d < today) d = rollForward(clampDate(cur.y + 1, 1, 5));
    out.push(...found(m, d));
  }
  // Tax season ends April 15-ish; April 20 leaves room for the extension rush.
  for (const m of text.matchAll(
    /\bafter (?:(?:the |his |her |their )?tax(?:es| season| day| deadline| time)|taxes)\b/gi,
  )) {
    let d = rollForward(clampDate(cur.y, 4, 20));
    if (d < today) d = rollForward(clampDate(cur.y + 1, 4, 20));
    out.push(...found(m, d));
  }
  return out;
};

/** "in March", "early May", "end of June 2027", "after March". Needs a word like in/early/after so a bare month is ignored. */
const monthOnlyMatcher: Matcher = ({ text, today }) => {
  const out: Found[] = [];
  const re = new RegExp(
    `\\b(in|during|until|till|by|after|around|early|mid|late|end of|the end of|beginning of|start of|next)\\s+(${MONTH})\\b(?:\\s+(\\d{4}))?(?!\\s+\\d{1,2}(?:st|nd|rd|th)?\\b)`,
    "gi",
  );
  for (const m of text.matchAll(re)) {
    const q = (m[1] ?? "").toLowerCase();
    const month = MONTH_INDEX[(m[2] ?? "").toLowerCase()];
    if (month === undefined) continue;
    // "may" the verb: "he may call" is not May. Only "in/early/mid/late/end of/until/around May" counts.
    if (
      (m[2] ?? "").toLowerCase() === "may" &&
      !/^(in|early|mid|late|end of|the end of|until|till|around|during|beginning of|start of|next)$/.test(
        q,
      )
    )
      continue;
    const t = parts(today);
    const pick = (y: number): ISODate => {
      if (q === "after") {
        const s = shiftMonth(y, month, 1);
        return firstBizDay(s.y, s.m);
      }
      if (q === "mid") return rollForward(clampDate(y, month, 15));
      if (q === "late") return rollForward(clampDate(y, month, 25));
      if (q.includes("end")) return lastBizDay(y, month);
      return firstBizDay(y, month);
    };
    let target: ISODate | null = null;
    if (m[3]) {
      target = pick(Number(m[3]));
    } else {
      for (let y = t.y; y <= t.y + 4 && target === null; y += 1) {
        const cand = pick(y);
        if (cand >= today) target = cand;
        // The month we are in: "in October" on Oct 23 is not a future plan, and not next year either.
        else if (y === t.y && month === t.m) break;
      }
    }
    out.push(...found(m, target));
  }
  return out;
};

const MATCHERS: readonly Matcher[] = [
  isoMatcher,
  monthDayMatcher,
  numericMatcher,
  dayOfMonthMatcher,
  relativeSpanMatcher,
  periodMatcher,
  monthOnlyMatcher,
  weekdayMatcher,
  dayWordsMatcher,
];

// ---------------------------------------------------------------------------------------------
// hot, and "he wants a call back" without a date

const HOT_PATTERNS: readonly RegExp[] = [
  /\ba\.?s\.?a\.?p\b/gi,
  /\burgent(?:ly)?\b/gi,
  /\bhot(?![\s-]*(?:dogs?|wings?|sauce|tubs?|yoga|pot|food|tea|coffee|chicken|rod|shots?|meals?)\b)\b/gi,
  /\b(?:right away|immediately|in a (?:big )?rush|rushed?|time[- ]sensitive|top priority|emergency)\b/gi,
  /\b(?:wants?|needs?|wanted|needed|asking for)\s+(?:it|this|that|the (?:money|funds?|funding|advance|cash)|money|cash|funds?|funding|an advance)\s+(?:by\s+|before\s+)?(?:today|tonight|now|tomorrow|this week)\b/gi,
];
const NEGATION =
  /(?:^|\s)(?:not|no|isn'?t|aren'?t|wasn'?t|never|without|nothing)\s+(?:\w+\s+){0,2}$/i;

/** True when the note says he wants it fast. "Not urgent" and "no rush" do not count. */
export function detectHot(note: string): boolean {
  for (const re of HOT_PATTERNS) {
    for (const m of note.matchAll(re)) {
      const clause = clauseBefore(note, m.index ?? 0);
      if (!NEGATION.test(clause)) return true;
    }
  }
  return false;
}

const CALLBACK_PATTERNS: readonly RegExp[] = [
  /\bcall(?:s|ing)?\s+(?:(?:him|her|them|the owner|mike|\w+)\s+)?back\b/i,
  /\bcall[- ]?back\b/i,
  /\b(?:call|text|email|e-mail|ping|ring|reach out to|touch base with)\s+(?:him|her|them|me|the owner)\s+(?:again|later|soon|after|when|once|next)\b/i,
  /\bfollow[- ]?up\b/i,
  /\b(?:circle|loop|check|touch)\s+(?:back|base|in)\b/i,
  /\bget back to (?:him|her|them)\b/i,
  /\breach(?:ing)?\s+(?:back\s+)?out\b/i,
  /\btry\s+(?:(?:him|her|them)\s+)?again\b/i,
  /\brevisit\b/i,
  /\bremind\s+(?:him|her|them|me)\b/i,
  /\bafter\s+(?:he|she|they|the owner)\s+(?:talks?|speaks?|checks?|gets?|hears?|decides?|sees?|meets?|discusses)\b/i,
  /\bonce\s+(?:he|she|they|the owner)\b/i,
  /\bwhen\s+(?:he|she|they)(?:'s|'re| is| are| has| have)?\s+(?:back|ready|done|free)\b/i,
];

export function hasCallbackIntent(note: string): boolean {
  return CALLBACK_PATTERNS.some((re) => re.test(note));
}

// ---------------------------------------------------------------------------------------------
// putting it together

function paceWords(stage: StageKey): string {
  const rule = stageDef(stage).followUp;
  switch (rule.kind) {
    case "bdays":
      return `${rule.days} business day${rule.days === 1 ? "" : "s"}`;
    case "days":
      return `${rule.days} days`;
    case "months":
      return `${rule.months} months`;
    case "funded":
      return "30 days";
    case "lost":
      return "6 months";
  }
}

/** The stage's own pace as a date; the same pace Isaac would get by moving the client into that stage. */
function paceDate(stage: StageKey | undefined, today: ISODate): { dueOn: ISODate; words: string } {
  if (!stage) return { dueOn: addBusinessDays(today, 2), words: "2 business days" };
  const rule = stageDef(stage).followUp;
  switch (rule.kind) {
    case "bdays":
      return { dueOn: addBusinessDays(today, rule.days), words: paceWords(stage) };
    case "days":
      return { dueOn: addDays(today, rule.days), words: paceWords(stage) };
    case "months":
      return { dueOn: addMonths(today, rule.months), words: paceWords(stage) };
    case "funded":
      return { dueOn: addDays(today, 30), words: paceWords(stage) };
    case "lost":
      return { dueOn: addMonths(today, 6), words: paceWords(stage) };
  }
}

export function hintLabel(dueOn: ISODate, today: ISODate): string {
  if (dueOn === today) return "Today";
  return `${WEEKDAY_NAMES[dow(dueOn)]} ${formatDate(dueOn, today)}`;
}

const inWindow = (dueOn: ISODate, today: ISODate): boolean =>
  dueOn >= today && dueOn <= addMonths(today, MAX_FOLLOW_UP_MONTHS);

const quote = (s: string): string => `“${s.replace(/\s+/g, " ").trim()}”`;

export function noteHints(
  note: string,
  today: ISODate,
  opts: { stage?: StageKey } = {},
): NoteHints {
  const raw = note.slice(0, 5000);
  const hot = detectHot(raw);
  if (!raw.trim()) return { suggestions: [], hot: false };

  const ctx: Ctx = { text: clean(raw), today };
  const all = MATCHERS.flatMap((match) => match(ctx))
    .filter((f) => !readsAsPast(ctx.text, f.start, f.end))
    .filter((f) => inWindow(f.dueOn, today));

  // Overlapping readings of the same words ("next Tuesday" also contains "Tuesday"): earliest start wins, then the longest.
  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: Found[] = [];
  for (const f of all) {
    if (kept.some((k) => f.start < k.end && f.end > k.start)) continue;
    kept.push(f);
  }

  const suggestions: DateHint[] = [];
  const seen = new Set<ISODate>();
  for (const f of kept) {
    if (seen.has(f.dueOn)) continue;
    seen.add(f.dueOn);
    suggestions.push({
      dueOn: f.dueOn,
      label: hintLabel(f.dueOn, today),
      reason: `You wrote ${quote(raw.slice(f.start, f.end))}${f.why ? ` — ${f.why}` : ""}`,
    });
    if (suggestions.length >= MAX_HINTS) break;
  }

  if (suggestions.length === 0 && hot) {
    suggestions.push({
      dueOn: today,
      label: hintLabel(today, today),
      reason: "The note says he wants this fast, so call today",
    });
  } else if (suggestions.length === 0 && hasCallbackIntent(raw)) {
    const pace = paceDate(opts.stage, today);
    const where = opts.stage ? `${stageDef(opts.stage).label} usually` : "A client usually";
    suggestions.push({
      dueOn: pace.dueOn,
      label: hintLabel(pace.dueOn, today),
      reason: `No date I could read in the note — ${where} gets a call in ${pace.words}`,
    });
  }
  return { suggestions, hot };
}
