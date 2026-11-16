import { expectedMonth } from "../docs/freshness";
import { addMonths, type ISODate } from "../mca/dates";
import type { StipKind } from "../mca/stips";

/**
 * A lender's stips list, as the reader wrote it ("voided check", "last 3 months statements", "October statement",
 * "DL"), mapped onto checklist rows by code. The reader never picks a kind: these rules do, and anything they do not
 * recognise is kept as 'other' with the lender's own words, so nothing a lender asked for is dropped.
 */
export interface StipRequestRow {
  kind: StipKind;
  /** The statement month (first of the month) for bank statements; null otherwise. */
  period: ISODate | null;
  /** The lender's words, kept for 'other' and shown on the checklist. */
  label: string;
}

const MONTHS: Record<string, number> = {
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
const MONTH_WORD = new RegExp(`\\b(${Object.keys(MONTHS).join("|")})\\b(?:\\s+(\\d{4}))?`, "g");
const WORDS: Record<string, number> = {
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

const monthStart = (y: number, m: number): ISODate => `${y}-${String(m).padStart(2, "0")}-01`;

/** The most recent occurrence of a named month on or before today's month, unless the year is stated. */
function namedMonth(name: string, year: string | undefined, today: ISODate): ISODate {
  const m = MONTHS[name] ?? 1;
  if (year) return monthStart(Number(year), m);
  const ty = Number(today.slice(0, 4));
  const tm = Number(today.slice(5, 7));
  return monthStart(m <= tm ? ty : ty - 1, m);
}

/** The statement months one stips line asks for, or [] when it is not about statements. */
export function statementMonthsIn(label: string, today: ISODate): ISODate[] {
  const l = label.toLowerCase();
  const named = [...l.matchAll(MONTH_WORD)].map((m) => namedMonth(m[1] ?? "", m[2], today));
  if (named.length > 0) return [...new Set(named)];
  if (/\b(mtd|month[- ]to[- ]date|current month)\b/.test(l)) return [`${today.slice(0, 7)}-01`];
  const newest = expectedMonth(today);
  const n =
    /\b(?:last|past|most recent|latest|recent)?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:full\s+|complete\s+|recent\s+)?months?\b/.exec(
      l,
    );
  if (n) {
    const count = Math.min(12, Number(n[1]) || WORDS[n[1] ?? ""] || 1);
    const out: ISODate[] = [];
    for (let i = count - 1; i >= 0; i -= 1) out.push(addMonths(newest, -i));
    return out;
  }
  return [newest];
}

/** Which checklist kind a lender's words mean. */
export function stipKindOf(label: string): StipKind {
  const l = label.toLowerCase();
  if (/\b(void(ed)?|cancell?ed)\b.*\bche(ck|que)\b|\bvoided\b|\bbank letter\b/.test(l))
    return "voided_check";
  if (
    /\b(driver'?s?\s*licen[cs]e|dl|photo\s*id|government\s*id|passport|identification|\bid\b)\b/.test(
      l,
    )
  )
    return "drivers_license";
  if (/\b(processing|merchant services|credit card)\s+statements?\b|\bprocessing\b/.test(l))
    return "processing_statement";
  if (/\b(bank|business|checking|account)?\s*statements?\b|\bmtd\b|\bmonth[- ]to[- ]date\b/.test(l))
    return "bank_statement";
  if (/\b(signed\s+)?app(lication)?\b/.test(l)) return "signed_application";
  if (/\btax(es)?\b|\b1040\b|\b1120\b|\bschedule c\b/.test(l)) return "tax_return";
  if (/\b(lease|landlord|rent)\b/.test(l)) return "lease_letter";
  if (
    /\b(ownership|articles|certificate of (good standing|formation|incorporation)|ein letter)\b/.test(
      l,
    )
  )
    return "proof_of_ownership";
  return "other";
}

/** The reader's list → checklist rows, de-duplicated by kind and month. */
export function mapStipRequests(labels: readonly string[], today: ISODate): StipRequestRow[] {
  const out = new Map<string, StipRequestRow>();
  for (const raw of labels) {
    const label = raw.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!label) continue;
    const kind = stipKindOf(label);
    if (kind === "bank_statement") {
      for (const period of statementMonthsIn(label, today)) {
        const key = `bank_statement:${period}`;
        if (!out.has(key)) out.set(key, { kind, period, label });
      }
      continue;
    }
    const key = `${kind}:`;
    const have = out.get(key);
    if (!have) out.set(key, { kind, period: null, label });
    else if (kind === "other" && !have.label.includes(label))
      have.label = `${have.label}; ${label}`.slice(0, 120);
  }
  return [...out.values()];
}
