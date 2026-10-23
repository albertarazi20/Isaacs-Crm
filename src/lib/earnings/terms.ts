import type { FundingRow } from "../data/types";
import { toLocalInput } from "../format";
import type { ISODate } from "../mca/dates";
import {
  dateAtPaydown,
  paidToDateCents,
  paybackCents,
  payoffDate,
  renewalDate,
  type Frequency,
  type FundingTerms,
} from "../mca/funding";
import { parseFactor, parseMoney } from "../money";
import { centsFromPoints, formatPoints, pointsOf } from "./commission";

/** A funding row as the client page loads it. The two commission-received columns are new (migration 0020). */
export type EditableFunding = FundingRow & {
  commission_received_cents?: number | null;
  commission_received_on?: ISODate | null;
};

export type CommissionMode = "dollars" | "points";

/** Every field the Funding dialog edits, as the text boxes hold it. */
export interface TermsForm {
  fundedOn: string;
  funderName: string;
  amount: string;
  factorRate: string;
  payment: string;
  frequency: Frequency;
  positionNo: string;
  termDays: string;
  commissionMode: CommissionMode;
  commission: string;
  commissionReceived: string;
  commissionReceivedOn: string;
  paidBackOverride: string;
  lastPaymentOn: string;
  promiseToPayAt: string;
  promiseAmount: string;
  note: string;
}

export type TermsErrors = Partial<Record<keyof TermsForm, string>>;

/** 5000000 → "50000", 5012345 → "50123.45": parses back to the same cents. */
export function moneyInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const body = rem === 0 ? `${dollars}` : `${dollars}.${String(rem).padStart(2, "0")}`;
  return cents < 0 ? `-${body}` : body;
}

/** 1.31 → "1.31", 1.315 → "1.315". */
export function factorInput(f: number): string {
  const s = f.toFixed(3);
  return s.endsWith("0") ? s.slice(0, -1) : s;
}

export function termsForm(f: EditableFunding, timezone: string): TermsForm {
  return {
    fundedOn: f.funded_on,
    funderName: f.funder_name,
    amount: moneyInput(f.amount_cents),
    factorRate: factorInput(f.factor_rate),
    payment: moneyInput(f.payment_cents),
    frequency: f.frequency,
    positionNo: String(f.position_no),
    termDays: f.term_days === null ? "" : String(f.term_days),
    commissionMode: "dollars",
    commission: moneyInput(f.commission_cents),
    commissionReceived: moneyInput(f.commission_received_cents),
    commissionReceivedOn: f.commission_received_on ?? "",
    paidBackOverride: moneyInput(f.paid_back_override_cents),
    lastPaymentOn: f.last_payment_on ?? "",
    promiseToPayAt: f.promise_to_pay_at ? toLocalInput(f.promise_to_pay_at, timezone) : "",
    promiseAmount: moneyInput(f.promise_amount_cents),
    note: f.note,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Payoff beyond this many days is a mistyped remittance (the database refuses it too). */
export const MAX_PAYOFF_DAYS = 1830;
const DAYS_PER_REMITTANCE: Record<Frequency, number> = {
  daily: 7 / 5,
  weekly: 7,
  biweekly: 14,
  monthly: 30.5,
};

const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export interface CheckedTerms {
  errors: TermsErrors;
  /** The money terms, as soon as the four that define the advance are usable — so the preview keeps working while an optional field is wrong. */
  terms: FundingTerms | null;
  /** The commission in dollars, whichever way it was typed. */
  commissionCents: number | null;
}

export function checkTerms(f: TermsForm, today: ISODate): CheckedTerms {
  const errors: TermsErrors = {};

  if (!DATE_RE.test(f.fundedOn)) errors.fundedOn = "Pick the funded date";
  else if (f.fundedOn > today) errors.fundedOn = "The funded date can't be in the future";

  const amount = f.amount.trim() === "" ? null : parseMoney(f.amount);
  if (f.amount.trim() === "") errors.amount = "Enter the advance amount, like 50k";
  else if (amount === null) errors.amount = "Use an amount like 50k or $75,000";
  else if (amount <= 0) errors.amount = "The advance amount must be more than $0";
  else if (amount > 10_000_000_000)
    errors.amount = "The advance amount can be at most $100,000,000";

  const factor = parseFactor(f.factorRate);
  if (factor === null) errors.factorRate = "Factor rate must be between 1.00 and 3.00, like 1.35";

  const payment = f.payment.trim() === "" ? null : parseMoney(f.payment);
  if (f.payment.trim() === "") errors.payment = "Enter the remittance amount, like 450";
  else if (payment === null) errors.payment = "Use an amount like 450 or $1,200";
  else if (payment <= 0) errors.payment = "The remittance must be more than $0";

  const pos = Number(f.positionNo);
  if (!Number.isInteger(pos) || pos < 1 || pos > 20 || f.positionNo.trim() === "")
    errors.positionNo = "Position must be a whole number from 1 to 20";
  if (f.termDays.trim() !== "") {
    const t = Number(f.termDays);
    if (!Number.isInteger(t) || t < 1 || t > 3650)
      errors.termDays = "Term must be a whole number of days, 1 to 3,650";
  }
  if (/[\p{Cc}]/u.test(f.funderName)) errors.funderName = "The funder name must be one line";

  let terms: FundingTerms | null = null;
  const overrideCents = f.paidBackOverride.trim() === "" ? null : parseMoney(f.paidBackOverride);
  if (f.paidBackOverride.trim() !== "" && overrideCents === null)
    errors.paidBackOverride = "Use an amount like 12k or $12,500";

  if (
    DATE_RE.test(f.fundedOn) &&
    amount &&
    amount > 0 &&
    factor !== null &&
    payment &&
    payment > 0
  ) {
    terms = {
      fundedOn: f.fundedOn,
      amountCents: amount,
      factorRate: factor,
      paymentCents: payment,
      frequency: f.frequency,
      paidBackOverrideCents: overrideCents,
    };
    const payback = paybackCents(amount, factor);
    if (payment > payback) {
      errors.payment = "One remittance can't be more than the whole payback";
    } else if (Math.ceil(payback / payment) * DAYS_PER_REMITTANCE[f.frequency] > MAX_PAYOFF_DAYS) {
      errors.payment = `At ${money(payment)} this advance would take more than 5 years to pay back — check the remittance amount`;
    }
  }

  // commission, in dollars or points
  let commissionCents: number | null = null;
  if (f.commission.trim() !== "") {
    if (f.commissionMode === "points") {
      const pts = Number(f.commission.trim().replace(/%$/, ""));
      if (!Number.isFinite(pts) || pts < 0 || pts > 100)
        errors.commission = "Points must be between 0 and 100, like 5 or 6.5";
      else if (amount === null || amount <= 0)
        errors.commission = "Enter the advance amount first to turn points into dollars";
      else commissionCents = centsFromPoints(pts, amount);
    } else {
      commissionCents = parseMoney(f.commission);
      if (commissionCents === null) errors.commission = "Use an amount like 2500 or $2,500";
    }
    if (commissionCents !== null && amount !== null && commissionCents > amount) {
      errors.commission = "Commission can't be more than the advance";
      commissionCents = null;
    }
  }

  // commission received: the amount and the day travel together
  const gotText = f.commissionReceived.trim();
  const gotCents = gotText === "" ? null : parseMoney(gotText);
  if (gotText !== "" && gotCents === null)
    errors.commissionReceived = "Use an amount like 2500 or $2,500";
  if (gotText !== "" && gotCents !== null && f.commissionReceivedOn === "")
    errors.commissionReceivedOn = "Enter the day the commission arrived";
  if (gotText === "" && f.commissionReceivedOn !== "")
    errors.commissionReceived = "Enter the amount received, or clear the date";
  if (f.commissionReceivedOn !== "") {
    if (!DATE_RE.test(f.commissionReceivedOn))
      errors.commissionReceivedOn = "Pick the day it arrived";
    else if (f.commissionReceivedOn > today)
      errors.commissionReceivedOn = "The day it arrived can't be in the future";
  }

  if (f.lastPaymentOn !== "") {
    if (!DATE_RE.test(f.lastPaymentOn)) errors.lastPaymentOn = "Pick a date";
    else if (f.lastPaymentOn > today)
      errors.lastPaymentOn = "The last remittance can't be in the future";
    else if (DATE_RE.test(f.fundedOn) && f.lastPaymentOn < f.fundedOn)
      errors.lastPaymentOn = "The last remittance can't be before the funded date";
  }
  if (f.promiseToPayAt !== "" && !LOCAL_DT_RE.test(f.promiseToPayAt))
    errors.promiseToPayAt = "Pick a date and time";
  if (f.promiseAmount.trim() !== "") {
    const p = parseMoney(f.promiseAmount);
    if (p === null) errors.promiseAmount = "Use an amount like 1,500";
    else if (p <= 0) errors.promiseAmount = "The promised amount must be more than $0";
  }

  return { errors, terms, commissionCents };
}

/**
 * Switches the commission box between dollars and points without changing what it means: "$2,500" on a
 * $50,000 advance becomes "5" points, and back.
 */
export function switchCommissionMode(f: TermsForm, mode: CommissionMode): TermsForm {
  if (mode === f.commissionMode) return f;
  const amount = parseMoney(f.amount);
  let commission = f.commission;
  if (commission.trim() !== "" && amount !== null && amount > 0) {
    if (mode === "points") {
      const cents = parseMoney(commission);
      const p = cents === null ? null : pointsOf(cents, amount);
      if (p !== null) commission = formatPoints(p);
    } else {
      const pts = Number(commission.trim().replace(/%$/, ""));
      if (Number.isFinite(pts)) commission = moneyInput(centsFromPoints(pts, amount));
    }
  }
  return { ...f, commissionMode: mode, commission };
}

export interface TermsPreview {
  paybackCents: number;
  /** How many remittances it takes to pay the advance off. */
  remittances: number;
  payoffOn: ISODate | null;
  renewalOn: ISODate | null;
  pctPaid: number;
  commissionPoints: number | null;
}

export function termsPreview(
  terms: FundingTerms,
  commissionCents: number | null,
  today: ISODate,
): TermsPreview {
  const payback = paybackCents(terms.amountCents, terms.factorRate);
  const paid = paidToDateCents(terms, today);
  return {
    paybackCents: payback,
    remittances: Math.ceil(payback / terms.paymentCents),
    payoffOn: payoffDate(terms),
    renewalOn: renewalDate(terms, today),
    pctPaid: payback > 0 ? Math.round((paid / payback) * 1000) / 10 : 0,
    commissionPoints:
      commissionCents === null ? null : pointsOf(commissionCents, terms.amountCents),
  };
}

export interface RenewalMove {
  from: ISODate | null;
  to: ISODate | null;
}

/**
 * Whether saving these terms moves the renewal call, judged the way the database does: the day the merchant
 * crosses 50% paid down under the old terms against the new ones. Null when it doesn't move.
 */
export function renewalMove(before: FundingTerms, after: FundingTerms): RenewalMove | null {
  const from = dateAtPaydown(before, 50);
  const to = dateAtPaydown(after, 50);
  return from === to ? null : { from, to };
}

/** The values the server action takes, from a form that passed checkTerms. */
export function termsPayload(fundingId: string, f: TermsForm, commissionCents: number | null) {
  return {
    fundingId,
    fundedOn: f.fundedOn,
    funderName: f.funderName,
    amount: f.amount,
    factorRate: f.factorRate,
    payment: f.payment,
    frequency: f.frequency,
    positionNo: f.positionNo,
    termDays: f.termDays,
    commissionReceived: f.commissionReceived,
    paidBackOverride: f.paidBackOverride,
    promiseAmount: f.promiseAmount,
    note: f.note,
    commission: moneyInput(commissionCents),
    commissionReceivedOn: f.commissionReceivedOn || null,
    lastPaymentOn: f.lastPaymentOn || null,
    promiseToPayAt: f.promiseToPayAt || null,
  };
}
