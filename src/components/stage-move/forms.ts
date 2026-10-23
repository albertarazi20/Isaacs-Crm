import type { ClientCard } from "@/lib/data/types";
import { parseCommissionText } from "@/lib/earnings/commission";
import { DAYS_PER_REMITTANCE, MAX_PAYOFF_DAYS } from "@/lib/earnings/terms";
import { toLocalInput } from "@/lib/format";
import { addDays, addMonths, type ISODate } from "@/lib/mca/dates";
import {
  paybackCents,
  payoffDate,
  renewalDate,
  renewalDateFromTerm,
  type Frequency,
  type FundingTerms,
} from "@/lib/mca/funding";
import { defaultTimers, FUNDED_CHECK_IN_DAYS, LOST_FALLBACK_MONTHS } from "@/lib/mca/stages";
import type { StageKey } from "@/lib/mca/stages";
import { formatMoney, parseFactor, parseMoney } from "@/lib/money";

export const FREQUENCIES: readonly { value: Frequency; label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
];

/** "$550 daily remittance", "$2,000 every-other-week remittance". */
export const FREQUENCY_ADJECTIVE: Record<Frequency, string> = {
  daily: "daily",
  weekly: "weekly",
  biweekly: "every-other-week",
  monthly: "monthly",
};

export const DEFAULT_STAGES: readonly StageKey[] = [
  "default_workable",
  "default_bad",
  "legal_collections",
  "written_off",
];

export const isDefaultStage = (stage: StageKey) => DEFAULT_STAGES.includes(stage);

/**
 * Funded and lost always ask for details; a default stage asks only when there is an advance to stamp; "Phone call
 * scheduled" asks when the call is, unless one is already booked (QA I-8: the column says "time is booked").
 */
export function needsInput(
  card: Pick<ClientCard, "funding_id" | "scheduled_call_at" | "stage">,
  stage: StageKey,
): boolean {
  if (stage === "funded" || stage === "lost") return true;
  if (stage === "call_scheduled") return card.stage !== stage && card.scheduled_call_at === null;
  return isDefaultStage(stage) && card.funding_id !== null;
}

export type FormErrors<T> = Partial<Record<keyof T, string>>;

/** Cents back into what Isaac would type: 5000000 → "50000", 123450 → "1234.50". */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** The day and time typed for a booked call: filled in, and not on a day that has already gone. */
export function callTimeProblem(at: string, today: ISODate): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) return "Pick the day and time of the call";
  if (at.slice(0, 10) < today) return "That day has already passed — pick a time from now on";
  return undefined;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function moneyProblem(raw: string, required: boolean, ask: string): string | undefined {
  if (raw.trim() === "") return required ? ask : undefined;
  const cents = parseMoney(raw);
  if (cents === null) return "Use an amount like 50k or $75,000";
  if (required && cents <= 0) return ask;
  return undefined;
}

function wholeProblem(raw: string, what: string, min: number): string | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min
    ? undefined
    : `${what} must be a whole number, ${min} or more`;
}

function dateProblem(raw: string, today: ISODate, what: string): string | undefined {
  if (!DATE_RE.test(raw)) return `Pick the ${what} date`;
  if (raw > today) return `The ${what} date can't be in the future`;
  return undefined;
}

// ---- funded --------------------------------------------------------------------------------

export interface FundingForm {
  fundedOn: string;
  amount: string;
  factorRate: string;
  payment: string;
  frequency: Frequency;
  funderName: string;
  positionNo: string;
  termDays: string;
  commission: string;
}

/** Starting values for the Funded dialog, e.g. an accepted offer's terms. Anything left out keeps the dialog's own default. */
export type FundingPrefill = Partial<Omit<FundingForm, "fundedOn">>;

export function checkFunding(
  f: FundingForm,
  today: ISODate,
): { errors: FormErrors<FundingForm>; terms: FundingTerms | null } {
  const errors: FormErrors<FundingForm> = {};
  const set = <K extends keyof FundingForm>(k: K, msg: string | undefined) => {
    if (msg) errors[k] = msg;
  };
  set("fundedOn", dateProblem(f.fundedOn, today, "funded"));
  set("amount", moneyProblem(f.amount, true, "Enter the advance amount, like 50k"));
  const factor = parseFactor(f.factorRate);
  set(
    "factorRate",
    factor === null ? "Factor rate must be between 1.00 and 3.00, like 1.35" : undefined,
  );
  set("payment", moneyProblem(f.payment, true, "Enter the remittance amount, like 450"));
  set("positionNo", wholeProblem(f.positionNo, "Position", 1));
  if (!errors.positionNo && f.positionNo.trim() !== "" && Number(f.positionNo) > 20)
    errors.positionNo = "Position must be a whole number from 1 to 20";
  set("termDays", wholeProblem(f.termDays, "Term", 1));
  const amount = parseMoney(f.amount);
  const commission = parseCommissionText(f.commission, amount);
  set("commission", commission.ok ? undefined : commission.error);
  if (commission.ok && commission.cents !== null && amount !== null && commission.cents > amount)
    errors.commission = "Commission can't be more than the advance";
  const payment = parseMoney(f.payment);
  // The preview only needs the money terms, so it keeps working while an optional field is wrong.
  if (!DATE_RE.test(f.fundedOn) || !amount || !payment || factor === null)
    return { errors, terms: null };
  const terms: FundingTerms = {
    fundedOn: f.fundedOn,
    amountCents: amount,
    factorRate: factor,
    paymentCents: payment,
    frequency: f.frequency,
  };
  const payback = paybackCents(amount, factor);
  if (payment > payback) errors.payment = "One remittance can't be more than the whole payback";
  else if (Math.ceil(payback / payment) * DAYS_PER_REMITTANCE[f.frequency] > MAX_PAYOFF_DAYS) {
    const remit = formatMoney(payment);
    errors.payment = `At ${remit} this advance would take more than 5 years to pay back — check the remittance amount`;
  }
  return { errors, terms };
}

export interface FundingPreview {
  paybackCents: number;
  paymentCount: number;
  payoffOn: ISODate | null;
  renewalOn: ISODate | null;
  checkInOn: ISODate;
}

export function fundingPreview(terms: FundingTerms, today: ISODate): FundingPreview {
  const payback = paybackCents(terms.amountCents, terms.factorRate);
  return {
    paybackCents: payback,
    paymentCount: Math.ceil(payback / terms.paymentCents),
    payoffOn: payoffDate(terms),
    renewalOn: renewalDate(terms, today),
    checkInOn: addDays(today, FUNDED_CHECK_IN_DAYS),
  };
}

// ---- lost deal -----------------------------------------------------------------------------

export interface CompetitorForm {
  funderName: string;
  amount: string;
  factorRate: string;
  payment: string;
  frequency: Frequency | "";
  positionNo: string;
  termDays: string;
  note: string;
}

export function checkCompetitor(f: CompetitorForm): FormErrors<CompetitorForm> {
  const errors: FormErrors<CompetitorForm> = {};
  if (f.funderName.trim() === "") errors.funderName = "Who did they go with?";
  const amount = moneyProblem(f.amount, false, "");
  if (amount) errors.amount = amount;
  if (f.factorRate.trim() !== "" && parseFactor(f.factorRate) === null)
    errors.factorRate = "Factor rate must be between 1.00 and 3.00, like 1.35";
  const payment = moneyProblem(f.payment, false, "");
  if (payment) errors.payment = payment;
  const pos = wholeProblem(f.positionNo, "Position", 1);
  if (pos) errors.positionNo = pos;
  const term = wholeProblem(f.termDays, "Term", 1);
  if (term) errors.termDays = term;
  return errors;
}

export interface Callback {
  dueOn: ISODate;
  /** `term`: half the competitor's term. `fallback`: no usable term, so 6 months. */
  basis: "term" | "fallback";
}

/** Mirrors the server: callback at 50% of the competitor's term, else six months out. */
export function competitorCallback(termDays: string, today: ISODate): Callback {
  const n = Number(termDays);
  if (termDays.trim() !== "" && Number.isInteger(n) && n >= 1)
    return { dueOn: renewalDateFromTerm(today, n), basis: "term" };
  return { dueOn: addMonths(today, LOST_FALLBACK_MONTHS), basis: "fallback" };
}

// ---- default stages ------------------------------------------------------------------------

export interface DefaultForm {
  defaultedOn: string;
  promiseAt: string;
  promiseAmount: string;
  note: string;
}

export function checkDefault(f: DefaultForm, today: ISODate): FormErrors<DefaultForm> {
  const errors: FormErrors<DefaultForm> = {};
  const d = dateProblem(f.defaultedOn, today, "default");
  if (d) errors.defaultedOn = d;
  if (f.promiseAt !== "" && !LOCAL_DT_RE.test(f.promiseAt))
    errors.promiseAt = "Pick a date and a time for the promise";
  const amt = moneyProblem(f.promiseAmount, false, "");
  if (amt) errors.promiseAmount = amt;
  return errors;
}

export interface DefaultFollowUp {
  dueOn: ISODate;
  /** `promise`: follow up the day the merchant said they'd pay, because it is sooner than the usual timer. */
  basis: "stage" | "promise";
}

export function defaultFollowUp(
  stage: StageKey,
  promiseAt: string,
  today: ISODate,
): DefaultFollowUp {
  const base = defaultTimers(stage, { today })[0]?.dueOn ?? today;
  const day = LOCAL_DT_RE.test(promiseAt) ? promiseAt.slice(0, 10) : null;
  if (day !== null && day >= today && day < base) return { dueOn: day, basis: "promise" };
  return { dueOn: base, basis: "stage" };
}

/** Undo: yesterday's due date can't be restored (the server rejects the past), so it becomes today. */
export function clampToToday(due: ISODate, today: ISODate): ISODate {
  return due < today ? today : due;
}

export interface UndoInput {
  clientId: string;
  stage: StageKey;
  followUpOn?: ISODate;
  default?: { defaultedOn?: ISODate; promiseToPayAt?: string; promiseAmount?: string };
}

/**
 * The move that puts a client back where it was, or null when a plain move back would not be a
 * true undo: leaving Funded would record a second advance, and a move that wrote a funding or
 * competitor record leaves that record behind.
 */
/** Did this move write something a plain move back would leave behind (an advance, a rival's offer, a booked call)? */
export const wroteRecord = (extra: Record<string, unknown>): boolean =>
  "funding" in extra || "competitor" in extra || "callAt" in extra;

export function undoInput(
  prev: ClientCard,
  to: StageKey,
  wroteRecord: boolean,
  ctx: { today: ISODate; timezone: string },
): UndoInput | null {
  if (prev.stage === "funded" || to === "funded" || wroteRecord) return null;
  const out: UndoInput = { clientId: prev.id, stage: prev.stage };
  if (prev.next_due_on) out.followUpOn = clampToToday(prev.next_due_on, ctx.today);
  // Moving back into a default stage re-stamps the advance, so hand its promise back intact.
  if (isDefaultStage(prev.stage) && prev.funding_id !== null) {
    out.default = {};
    if (prev.defaulted_on) out.default.defaultedOn = prev.defaulted_on;
    if (prev.promise_to_pay_at)
      out.default.promiseToPayAt = toLocalInput(prev.promise_to_pay_at, ctx.timezone);
    if (prev.promise_amount_cents !== null)
      out.default.promiseAmount = centsToInput(prev.promise_amount_cents);
  }
  return out;
}
