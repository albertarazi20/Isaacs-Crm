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
