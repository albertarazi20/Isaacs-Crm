import { expectedMonth } from "../docs/freshness";
import { addMonths, parseISODate, toISODate, type ISODate } from "./dates";

export type StipKind =
  | "signed_application"
  | "bank_statement"
  | "drivers_license"
  | "voided_check"
  | "proof_of_ownership"
  | "tax_return"
  | "lease_letter"
  | "processing_statement"
  | "other";

export const STIP_LABELS: Record<StipKind, string> = {
  signed_application: "Signed application",
  bank_statement: "Bank statement",
  drivers_license: "Driver's license / ID",
  voided_check: "Voided check",
  proof_of_ownership: "Proof of ownership",
  tax_return: "Tax return",
  lease_letter: "Landlord / lease letter",
  processing_statement: "Processing statement",
  other: "Other",
};

export interface StipInput {
  kind: StipKind;
  /** First of the month for bank statements, otherwise null. */
  period: ISODate | null;
  required: boolean;
  received: boolean;
}

export interface StipSeed {
  kind: StipKind;
  period: ISODate | null;
  required: boolean;
}

/**
 * Default checklist when an application lands. Statements are one box per month — "statements:
 * partial" tells Isaac nothing, "Oct missing" does. The last N months a lender expects are required, ending at
 * the newest one that exists: before the 5th, last month's statement is not out yet (freshness.ts expectedMonth).
 */
export function defaultStips(asOf: ISODate, statementMonths = 4): StipSeed[] {
  const newest = expectedMonth(asOf);
  const statements: StipSeed[] = [];
  for (let i = statementMonths - 1; i >= 0; i -= 1) {
    statements.push({
      kind: "bank_statement",
      period: addMonths(newest, -i),
      required: true,
    });
  }
  return [
    { kind: "signed_application", period: null, required: true },
    ...statements,
    { kind: "drivers_license", period: null, required: true },
    { kind: "voided_check", period: null, required: true },
    { kind: "proof_of_ownership", period: null, required: false },
    { kind: "tax_return", period: null, required: false },
    { kind: "lease_letter", period: null, required: false },
    { kind: "processing_statement", period: null, required: false },
  ];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function stipLabel(s: Pick<StipInput, "kind" | "period">): string {
  if (s.kind === "bank_statement" && s.period) {
    const d = parseISODate(s.period);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} statement`;
  }
  return STIP_LABELS[s.kind];
}

export interface StipRollup {
  requiredTotal: number;
  requiredReceived: number;
  missing: string[];
  /** Every required stip is in — the card goes green. */
  ready: boolean;
}

export function stipRollup(stips: readonly StipInput[]): StipRollup {
  const required = stips.filter((s) => s.required);
  const missing = required.filter((s) => !s.received).map(stipLabel);
  return {
    requiredTotal: required.length,
    requiredReceived: required.length - missing.length,
    missing,
    ready: required.length > 0 && missing.length === 0,
  };
}

export function monthStart(d: Date): ISODate {
  return `${toISODate(d).slice(0, 7)}-01`;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "A", "A and B", "A, B and C". */
function listInWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const OWED: Partial<Record<StipKind, string>> = {
  signed_application: "the signed application",
  drivers_license: "a photo of your driver's license",
  voided_check: "a voided check",
  proof_of_ownership: "proof of ownership",
  tax_return: "your tax return",
  lease_letter: "a landlord or lease letter",
  processing_statement: "your processing statements",
};

/**
 * What a merchant still owes, in the words an email uses: "the signed application, your August and September bank
 * statements and a voided check". The {missing_docs} merge field. Empty when nothing is missing (the field is then
 * reported, never sent blank). "Other" items have no fixed wording and are left out.
 */
export function missingDocsPhrase(missing: readonly Pick<StipInput, "kind" | "period">[]): string {
  const months = [
    ...new Set(
      missing
        .filter((s) => s.kind === "bank_statement")
        .map((s) => s.period)
        .filter((p): p is ISODate => Boolean(p)),
    ),
  ].sort();
  const anyStatement = missing.some((s) => s.kind === "bank_statement");
  const years = new Set(months.map((p) => p.slice(0, 4)));
  const monthWord = (p: ISODate) => {
    const d = parseISODate(p);
    const name = MONTH_NAMES[d.getUTCMonth()]!;
    return years.size > 1 ? `${name} ${d.getUTCFullYear()}` : name;
  };
  const parts: string[] = [];
  if (missing.some((s) => s.kind === "signed_application")) parts.push(OWED.signed_application!);
  if (months.length > 0)
    parts.push(
      `your ${listInWords(months.map(monthWord))} bank statement${months.length > 1 ? "s" : ""}`,
    );
  else if (anyStatement) parts.push("your recent bank statements");
  for (const kind of [
    "drivers_license",
    "voided_check",
    "proof_of_ownership",
    "tax_return",
    "lease_letter",
    "processing_statement",
  ] as const)
    if (missing.some((s) => s.kind === kind)) parts.push(OWED[kind]!);
  return listInWords(parts);
}
