/**
 * Auto-labelling of an uploaded file from its name and type. Rules first (free, instant, explainable); the AI reader
 * is a later fallback for the files these rules cannot place. Confidence is honest: a rep confirms anything under 0.8.
 */
import type { ISODate } from "../mca/dates";

export const DOC_KINDS = [
  "signed_application",
  "bank_statement",
  "drivers_license",
  "voided_check",
  "proof_of_ownership",
  "tax_return",
  "lease_letter",
  "processing_statement",
  "signed_contract",
  "funding_agreement",
  "offer_sheet",
  "other",
] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_LABELS: Record<DocKind, string> = {
  signed_application: "Signed application",
  bank_statement: "Bank statement",
  drivers_license: "Driver's license / ID",
  voided_check: "Voided check",
  proof_of_ownership: "Proof of ownership",
  tax_return: "Tax return",
  lease_letter: "Landlord / lease letter",
  processing_statement: "Processing statement",
  signed_contract: "Signed contract",
  funding_agreement: "Funding agreement",
  offer_sheet: "Offer sheet",
  other: "Other document",
};

/** The kinds a stip can name; a received one ticks the merchant's checklist. */
export const STIP_KINDS = new Set<DocKind>([
  "signed_application",
  "bank_statement",
  "drivers_license",
  "voided_check",
  "proof_of_ownership",
  "tax_return",
  "lease_letter",
  "processing_statement",
]);

export interface Label {
  kind: DocKind;
  /** First day of the statement month, for bank statements with a month in the name. */
  period: ISODate | null;
  /** 0–1. */
  confidence: number;
  /** Why, in a few words, for the tooltip and the audit row. */
  reason: string;
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

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The statement month in a file name: "Oct 2026", "October_2026", "2026-10", "10-2026", "10_26", "2026_10_31".
 * `today` keeps a two-digit year honest and refuses months in the future.
 */
export function periodFromName(name: string, today: ISODate): ISODate | null {
  const n = name.toLowerCase().replace(/\.[a-z0-9]+$/, "");
  const ty = Number(today.slice(0, 4));
  const tm = Number(today.slice(5, 7));
  const ok = (y: number, m: number): ISODate | null =>
    m >= 1 && m <= 12 && y >= ty - 3 && (y < ty || (y === ty && m <= tm))
      ? `${y}-${pad(m)}-01`
      : null;

  let m: RegExpMatchArray | null;
  // 2026-10, 2026_10, 2026.10, 202610 (optionally followed by a day)
  if (
    (m = n.match(
      /(?:^|\D)(20\d{2})[-_. ]?(0[1-9]|1[0-2])(?:[-_. ]?(?:0[1-9]|[12]\d|3[01]))?(?!\d)/,
    ))
  ) {
    const r = ok(Number(m[1]), Number(m[2]));
    if (r) return r;
  }
  // 10-2026, 10_2026, 10.2026 (day-month-year is read as month-year when the first part is ≤ 12)
  if ((m = n.match(/(?:^|\D)(0?[1-9]|1[0-2])[-_. ](20\d{2})(?!\d)/))) {
    const r = ok(Number(m[2]), Number(m[1]));
    if (r) return r;
  }
  // oct 2026, october_2026, oct26, oct-26
  if (
    (m = n.match(
      /(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*[-_. ]?'?(20\d{2}|\d{2})(?!\d)/,
    ))
  ) {
    const y = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    const r = ok(y, MONTHS[m[1]!] ?? 0);
    if (r) return r;
  }
  // 10_26, 10-26 as month_yy (two-digit year only when it reads as a recent year)
  if ((m = n.match(/(?:^|\D)(0?[1-9]|1[0-2])[-_](2[4-9])(?!\d)/))) {
    const r = ok(2000 + Number(m[2]), Number(m[1]));
    if (r) return r;
  }
  return null;
}

const IMAGE = /^image\/(jpeg|png|heic|heif|webp)$/;

export function labelFile(filename: string, contentType: string, today: ISODate): Label {
  const n = filename.toLowerCase();
  const has = (...words: string[]) => words.some((w) => n.includes(w));
  const period = periodFromName(filename, today);

  if (
    has(
      "statement",
      "stmt",
      "bank",
      "checking",
      "chase",
      "wells",
      "bofa",
      "bank of america",
      "pnc",
      "truist",
      "citi",
      "capital one",
      "td bank",
      "us bank",
      "regions",
    )
  ) {
    if (has("processing", "merchant services", "square", "clover", "stripe", "paypal", "toast"))
      return {
        kind: "processing_statement",
        period,
        confidence: 0.8,
        reason: "processing statement in the name",
      };
    return {
      kind: "bank_statement",
      period,
      confidence: period ? 0.9 : 0.75,
      reason: period ? "bank + month in the name" : "bank in the name, month unknown",
    };
  }
  if (
    has("processing statement", "merchant statement", "processing_statement", "merchant_statement")
  )
    return {
      kind: "processing_statement",
      period,
      confidence: 0.8,
      reason: "merchant processing statement",
    };
  if (has("application", "app ", "app_", "app-", "mca app", "signed app"))
    return {
      kind: "signed_application",
      period: null,
      confidence: 0.8,
      reason: "application in the name",
    };
  if (has("void", "voided", "check", "cheque"))
    return {
      kind: "voided_check",
      period: null,
      confidence: 0.8,
      reason: "void/check in the name",
    };
  if (
    has(
      "license",
      "licence",
      "driver",
      "passport",
      " id.",
      "_id.",
      "-id.",
      "dl.",
      "dl_",
      "dl-",
      "identification",
    )
  )
    return { kind: "drivers_license", period: null, confidence: 0.8, reason: "ID in the name" };
  if (has("1040", "1120", "1065", "schedule c", "tax", "return"))
    return { kind: "tax_return", period: null, confidence: 0.8, reason: "tax form in the name" };
  if (has("lease", "landlord", "mortgage"))
    return {
      kind: "lease_letter",
      period: null,
      confidence: 0.8,
      reason: "lease/landlord in the name",
    };
  if (
    has(
      "articles",
      "ein",
      "incorporation",
      "llc",
      "ownership",
      "certificate",
      "operating agreement",
    )
  )
    return {
      kind: "proof_of_ownership",
      period: null,
      confidence: 0.7,
      reason: "entity paperwork in the name",
    };
  if (has("contract", "agreement", "signed", "docusign", "executed"))
    return {
      kind: has("funding") ? "funding_agreement" : "signed_contract",
      period: null,
      confidence: 0.7,
      reason: "contract/agreement in the name",
    };
  if (has("offer", "approval", "term sheet", "termsheet"))
    return { kind: "offer_sheet", period: null, confidence: 0.7, reason: "offer in the name" };
  // a bare month in the name is almost always a statement
  if (period)
    return {
      kind: "bank_statement",
      period,
      confidence: 0.6,
      reason: "a month in the name, nothing else",
    };
  // a photo with no words is usually the ID or the check
  if (IMAGE.test(contentType))
    return {
      kind: "drivers_license",
      period: null,
      confidence: 0.35,
      reason: "a photo with no telling name",
    };
  return { kind: "other", period: null, confidence: 0.2, reason: "nothing in the name to go on" };
}

export const labelOf = (kind: DocKind, period: ISODate | null): string =>
  kind === "bank_statement" && period ? `${monthName(period)} bank statement` : DOC_LABELS[kind];

export function monthName(period: ISODate): string {
  const d = new Date(`${period.slice(0, 7)}-15T00:00:00Z`);
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
