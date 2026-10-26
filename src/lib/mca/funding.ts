import {
  addBusinessDays,
  addDays,
  addMonths,
  businessDaysBetween,
  diffDays,
  type ISODate,
} from "./dates";

export type Frequency = "daily" | "weekly" | "biweekly" | "monthly";

export interface FundingTerms {
  fundedOn: ISODate;
  amountCents: number;
  factorRate: number;
  paymentCents: number;
  frequency: Frequency;
  /** Manual override when Isaac knows the real collected number (statement, funder portal). */
  paidBackOverrideCents?: number | null;
}

/**
 * payback = amount × factor, rounded half-up to the cent exactly as the database's generated column does
 * (`round(amount_cents * factor_rate)` on numeric). Done on integers: the factor is read in thousandths, so a
 * half-cent product such as $1,385 × 1.251 does not drift in floating point. Never "interest" — an MCA buys
 * receivables at a discount.
 */
export function paybackCents(amountCents: number, factorRate: number): number {
  const thousandths = Math.round(factorRate * 1000);
  if (Math.abs(factorRate * 1000 - thousandths) > 1e-6) return Math.round(amountCents * factorRate);
  return Math.floor((amountCents * thousandths + 500) / 1000);
}

/** Remittances that have come due in the half-open range (fundedOn, asOf]. */
export function remittancesElapsed(fundedOn: ISODate, asOf: ISODate, frequency: Frequency): number {
  if (asOf <= fundedOn) return 0;
  switch (frequency) {
    case "daily":
      return businessDaysBetween(fundedOn, asOf);
    case "weekly":
      return Math.floor(diffDays(fundedOn, asOf) / 7);
    case "biweekly":
      return Math.floor(diffDays(fundedOn, asOf) / 14);
    case "monthly": {
      let n = 0;
      while (addMonths(fundedOn, n + 1) <= asOf) n += 1;
      return n;
    }
  }
}

export function paidToDateCents(f: FundingTerms, asOf: ISODate): number {
  const payback = paybackCents(f.amountCents, f.factorRate);
  if (f.paidBackOverrideCents != null)
    return Math.min(payback, Math.max(0, f.paidBackOverrideCents));
  return Math.min(payback, remittancesElapsed(f.fundedOn, asOf, f.frequency) * f.paymentCents);
}

export function balanceCents(f: FundingTerms, asOf: ISODate): number {
  return paybackCents(f.amountCents, f.factorRate) - paidToDateCents(f, asOf);
}

/** 0–100, one decimal. */
export function paydownPct(f: FundingTerms, asOf: ISODate): number {
  const payback = paybackCents(f.amountCents, f.factorRate);
  if (payback <= 0) return 0;
  return Math.round((paidToDateCents(f, asOf) / payback) * 1000) / 10;
}

/** Date the merchant crosses `pct` paid down (renewal window). Null when the payment is unusable. */
export function dateAtPaydown(f: FundingTerms, pct: number): ISODate | null {
  if (f.paymentCents <= 0) return null;
  const target = (pct / 100) * paybackCents(f.amountCents, f.factorRate);
  const n = Math.ceil(target / f.paymentCents);
  switch (f.frequency) {
    case "daily":
      return addBusinessDays(f.fundedOn, n);
    case "weekly":
      return addDays(f.fundedOn, 7 * n);
    case "biweekly":
      return addDays(f.fundedOn, 14 * n);
    case "monthly":
      return addMonths(f.fundedOn, n);
  }
}

/** Estimated term end — when the last remittance lands. */
export function payoffDate(f: FundingTerms): ISODate | null {
  return dateAtPaydown(f, 100);
}

export const RENEWAL_PAYDOWN_PCT = 50;

/** Renewal call lands the day the merchant hits 50% — or today if they already have. */
export function renewalDate(f: FundingTerms, today: ISODate): ISODate | null {
  const at = dateAtPaydown(f, RENEWAL_PAYDOWN_PCT);
  if (!at) return null;
  return at < today ? today : at;
}

/**
 * A lost deal only tells us the competitor's term, not their payment schedule. Assume it funded
 * around `lostOn` and call back when the term is `RENEWAL_PAYDOWN_PCT` through.
 */
export function renewalDateFromTerm(lostOn: ISODate, termDays: number): ISODate {
  return addDays(lostOn, Math.round((termDays * RENEWAL_PAYDOWN_PCT) / 100));
}
