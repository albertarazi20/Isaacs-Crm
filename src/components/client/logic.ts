import type {
  ActivityRow,
  AskRow,
  ClientCard,
  FundingRow,
  OfferRow,
  PositionRow,
  StipRow,
} from "@/lib/data/types";
import type { ISODate } from "@/lib/mca/dates";
import { diffDays } from "@/lib/mca/dates";
import {
  paidToDateCents,
  paybackCents,
  paydownPct,
  payoffDate,
  RENEWAL_PAYDOWN_PCT,
  renewalDate,
  type Frequency,
  type FundingTerms,
} from "@/lib/mca/funding";
import { stackRollup, type StackRollup } from "@/lib/mca/positions";
import {
  STIP_LABELS,
  stipRollup,
  type StipInput,
  type StipKind,
  type StipRollup,
} from "@/lib/mca/stips";
import { formatDate, timeAgo, toLocalInput } from "@/lib/format";
import { formatMoney } from "@/lib/money";

// ---------------------------------------------------------------------------------------------
// timeline

export type TimelineFilter = "all" | "notes" | "contact" | "stage";

export const TIMELINE_FILTERS: readonly { key: TimelineFilter; label: string; hint: string }[] = [
  { key: "all", label: "All", hint: "Everything on this client" },
  { key: "notes", label: "Notes", hint: "Only notes" },
  { key: "contact", label: "Calls & texts", hint: "Calls, texts and emails" },
  { key: "stage", label: "Stage changes", hint: "Moves between stages" },
];

const CONTACT_KINDS: ReadonlySet<ActivityRow["kind"]> = new Set(["call", "text", "email"]);

export function matchesFilter(kind: ActivityRow["kind"], filter: TimelineFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "notes":
      return kind === "note";
    case "contact":
      return CONTACT_KINDS.has(kind);
    case "stage":
      return kind === "stage_change";
  }
}

export function filterActivities<T extends Pick<ActivityRow, "kind">>(
  rows: readonly T[],
  filter: TimelineFilter,
): T[] {
  return rows.filter((r) => matchesFilter(r.kind, filter));
}

export function countByFilter(
  rows: readonly Pick<ActivityRow, "kind">[],
): Record<TimelineFilter, number> {
  return {
    all: rows.length,
    notes: filterActivities(rows, "notes").length,
    contact: filterActivities(rows, "contact").length,
    stage: filterActivities(rows, "stage").length,
  };
}

/**
 * The database writes some bodies for machines: "Received: bank_statement Jul 2026" and
 * "Follow up set for 2027-01-23". Say them the way the rest of the page does.
 */
export function activityBody(a: Pick<ActivityRow, "kind" | "body">, today?: ISODate): string {
  if (a.kind === "timer") {
    return a.body.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => {
      try {
        return formatDate(d, today);
      } catch {
        return d;
      }
    });
  }
  if (a.kind === "funding") {
    const m = /^Funded \$(\d+) at ([\d.]+)$/.exec(a.body);
    return m
      ? `Funded ${formatMoney(Number(m[1]) * 100)} at ${formatFactor(Number(m[2]))} factor`
      : a.body;
  }
  if (a.kind !== "system") return a.body;
  const m = /^(Received|Marked missing): ([a-z_]+)(?: ([A-Z][a-z]{2} \d{4}))?$/.exec(a.body);
  const kind = m?.[2];
  if (!m || !kind || !(kind in STIP_LABELS)) return a.body;
  const label =
    kind === "bank_statement" && m[3] ? `${m[3]} statement` : STIP_LABELS[kind as StipKind];
  return `${m[1]}: ${label}`;
}

export interface LastTouch {
  kind: "call" | "text" | "email";
  atIso: string;
}

/** Newest call, text or email in the timeline — "the last follow-up". */
export function lastTouchOf(
  rows: readonly Pick<ActivityRow, "kind" | "occurred_at">[],
): LastTouch | null {
  let best: LastTouch | null = null;
  for (const r of rows) {
    if (!CONTACT_KINDS.has(r.kind)) continue;
    if (!best || new Date(r.occurred_at).getTime() > new Date(best.atIso).getTime())
      best = { kind: r.kind as LastTouch["kind"], atIso: r.occurred_at };
  }
  return best;
}

export type LastCall = { never: true } | { never: false; ago: string; note: string; atIso: string };

export function lastCallSummary(
  card: Pick<ClientCard, "last_call_at" | "last_call_note">,
  now: Date,
): LastCall {
  if (!card.last_call_at) return { never: true };
  return {
    never: false,
    ago: timeAgo(card.last_call_at, now),
    note: (card.last_call_note ?? "").trim(),
    atIso: card.last_call_at,
  };
}

// ---------------------------------------------------------------------------------------------
// dates

/** "Fri, Oct 23, 2026, 3:42 PM" — for title attributes, where the exact moment matters. */
export function fullDateTime(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** The calendar day an instant falls on in Isaac's timezone. */
export function dateInTz(iso: string, timezone: string): ISODate {
  return toLocalInput(iso, timezone).slice(0, 10);
}

export type DueTone = "overdue" | "today" | "later";

export function dueTone(dueOn: ISODate, today: ISODate): DueTone {
  const diff = diffDays(today, dueOn);
  return diff < 0 ? "overdue" : diff === 0 ? "today" : "later";
}

// ---------------------------------------------------------------------------------------------
// money in and out of form fields

/** 5000000 → "50000", 5012345 → "50123.45". Always parses back to the same cents with parseMoney. */
export function centsToInput(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  return rem === 0 ? `${sign}${dollars}` : `${sign}${dollars}.${String(rem).padStart(2, "0")}`;
}

export function intToInput(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : String(n);
}

/** 1.31 → "1.31", 1.315 → "1.315" — two decimals unless a third is real. */
export function formatFactor(f: number | null | undefined): string {
  if (f === null || f === undefined) return "—";
  const s = f.toFixed(3);
  return s.endsWith("0") ? s.slice(0, -1) : s;
}

const FREQ_UNIT: Record<Frequency, string> = {
  daily: "/day",
  weekly: "/week",
  biweekly: " every 2 weeks",
  monthly: "/month",
};

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
};

/** "$550/day". `money` is passed in so this stays free of Intl in tests. */
export function remittanceLabel(
  cents: number | null | undefined,
  frequency: Frequency | null | undefined,
  money: (c: number) => string,
): string {
  if (cents === null || cents === undefined) return "—";
  return `${money(cents)}${frequency ? FREQ_UNIT[frequency] : ""}`;
}

// ---------------------------------------------------------------------------------------------
// positions

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export const MAX_POSITION = 20;

/** What the position field starts as for a new row: one deeper than the stack so far (schema caps at 20). */
export function nextPositionNo(positions: readonly Pick<PositionRow, "position_no">[]): number {
  const deepest = positions.reduce((mx, p) => Math.max(mx, p.position_no), 0);
  return Math.min(MAX_POSITION, deepest + 1);
}

export function positionRollup(positions: readonly PositionRow[]): StackRollup {
  return stackRollup(
    positions.map((p) => ({
      positionNo: p.position_no,
      funderName: p.funder_name,
      fundedAmountCents: p.funded_amount_cents,
      balanceCents: p.balance_cents,
      paybackCents: p.payback_cents,
    })),
  );
}

/** One position's own progress; null without a payback figure (never guess). */
export function positionPaidDownPct(p: Pick<PositionRow, "payback_cents" | "balance_cents">) {
  if (!p.payback_cents || p.payback_cents <= 0) return null;
  const pct = (1 - p.balance_cents / p.payback_cents) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

// ---------------------------------------------------------------------------------------------
// competing offers

export interface OfferInsight {
  /** Mean factor rate across the offers that list one, to three decimals. */
  average: number;
  low: number;
  high: number;
  /** Offers that list a factor. */
  counted: number;
  total: number;
}

export function offerInsight(
  offers: readonly Pick<OfferRow, "factor_rate">[],
): OfferInsight | null {
  if (offers.length < 2) return null;
  const thousandths = offers
    .map((o) => o.factor_rate)
    .filter((f): f is number => f !== null && Number.isFinite(f))
    .map((f) => Math.round(f * 1000));
  if (thousandths.length === 0) return null;
  const sum = thousandths.reduce((s, n) => s + n, 0);
  return {
    average: Math.round(sum / thousandths.length) / 1000,
    low: Math.min(...thousandths) / 1000,
    high: Math.max(...thousandths) / 1000,
    counted: thousandths.length,
    total: offers.length,
  };
}

// ---------------------------------------------------------------------------------------------
// stips

const STIP_ORDER: readonly StipKind[] = [
  "signed_application",
  "bank_statement",
  "drivers_license",
  "voided_check",
  "proof_of_ownership",
  "tax_return",
  "lease_letter",
  "processing_statement",
  "other",
];

/** Checklist order: application, statements oldest first, then ID and check — not alphabetical. */
export function sortStips(stips: readonly StipRow[]): StipRow[] {
  return [...stips].sort(
    (a, b) =>
      STIP_ORDER.indexOf(a.kind) - STIP_ORDER.indexOf(b.kind) ||
      (a.period ?? "").localeCompare(b.period ?? ""),
  );
}

export function splitStips(stips: readonly StipRow[]): {
  required: StipRow[];
  optional: StipRow[];
} {
  const sorted = sortStips(stips);
  return {
    required: sorted.filter((s) => s.required),
    optional: sorted.filter((s) => !s.required),
  };
}

export function stipInputs(stips: readonly StipRow[]): StipInput[] {
  return stips.map((s) => ({
    kind: s.kind,
    period: s.period,
    required: s.required,
    received: s.received_at !== null,
  }));
}

export function rollupOf(stips: readonly StipRow[]): StipRollup {
  return stipRollup(stipInputs(sortStips(stips)));
}

/** The optimistic copy of the list after one checkbox flips. */
export function setStipReceived(
  stips: readonly StipRow[],
  id: string,
  received: boolean,
  atIso: string,
): StipRow[] {
  return stips.map((s) =>
    s.id === id ? { ...s, received_at: received ? (s.received_at ?? atIso) : null } : s,
  );
}

// ---------------------------------------------------------------------------------------------
// funding

export const FUNDING_STATUS_LABELS: Record<FundingRow["status"], string> = {
  active: "Active",
  paid_off: "Paid off",
  defaulted: "Defaulted",
  renewed: "Renewed",
};

export function fundingTerms(f: FundingRow): FundingTerms {
  return {
    fundedOn: f.funded_on,
    amountCents: f.amount_cents,
    factorRate: f.factor_rate,
    paymentCents: f.payment_cents,
    frequency: f.frequency,
    paidBackOverrideCents: f.paid_back_override_cents,
  };
}

export interface FundingSnapshot {
  paybackCents: number;
  paidCents: number;
  balanceCents: number;
  /** 0–100, one decimal. */
  pct: number;
  /** True when Isaac typed the collected amount instead of us estimating from payments elapsed. */
  overridden: boolean;
  /** The day the merchant crosses 50% (today if already past it). Null when the payment is unusable. */
  renewalOn: ISODate | null;
  pastHalfway: boolean;
  payoffOn: ISODate | null;
}

export function fundingSnapshot(f: FundingRow, today: ISODate): FundingSnapshot {
  const terms = fundingTerms(f);
  const payback = paybackCents(terms.amountCents, terms.factorRate);
  const paid = paidToDateCents(terms, today);
  const pct = paydownPct(terms, today);
  return {
    paybackCents: payback,
    paidCents: paid,
    balanceCents: payback - paid,
    pct,
    overridden: f.paid_back_override_cents !== null,
    renewalOn: renewalDate(terms, today),
    pastHalfway: pct >= RENEWAL_PAYDOWN_PCT,
    payoffOn: payoffDate(terms),
  };
}

/** Broker commission in points of the advance ($2,500 on $50,000 = 5 points), one decimal. */
export function commissionPoints(
  commissionCents: number | null | undefined,
  amountCents: number,
): number | null {
  if (commissionCents === null || commissionCents === undefined || amountCents <= 0) return null;
  return Math.round((commissionCents / amountCents) * 1000) / 10;
}

// ---------------------------------------------------------------------------------------------
// forms: what the dialogs start with, and what they send

export interface ClientForm {
  businessName: string;
  dba: string;
  contactName: string;
  phone: string;
  email: string;
  industry: string;
  state: string;
  source: string;
  monthlyRevenue: string;
  timeInBusinessMonths: string;
  applicationReceivedOn: string;
}

export function clientForm(c: ClientCard): ClientForm {
  return {
    businessName: c.business_name,
    dba: c.dba,
    contactName: c.contact_name,
    phone: c.phone,
    email: c.email,
    industry: c.industry,
    state: c.state,
    source: c.source,
    monthlyRevenue: centsToInput(c.monthly_revenue_cents),
    timeInBusinessMonths: intToInput(c.time_in_business_months),
    applicationReceivedOn: c.application_received_on ?? "",
  };
}

export function clientFieldsPayload(f: ClientForm) {
  return { ...f, applicationReceivedOn: f.applicationReceivedOn || null };
}

export interface AskForm {
  wantedAmount: string;
  wantedTerms: string;
  estApproval: string;
  estApprovalNote: string;
}

export function askForm(a: AskRow | undefined): AskForm {
  return {
    wantedAmount: centsToInput(a?.wanted_amount_cents),
    wantedTerms: a?.wanted_terms ?? "",
    estApproval: centsToInput(a?.est_approval_cents),
    estApprovalNote: a?.est_approval_note ?? "",
  };
}

export interface PositionForm {
  positionNo: string;
  funderName: string;
  fundedAmount: string;
  payback: string;
  balance: string;
  payment: string;
  frequency: Frequency | "";
  fundedOn: string;
  note: string;
}

export function positionForm(p: PositionRow | undefined, nextNo: number): PositionForm {
  if (!p) {
    return {
      positionNo: String(nextNo),
      funderName: "",
      fundedAmount: "",
      payback: "",
      balance: "",
      payment: "",
      frequency: "",
      fundedOn: "",
      note: "",
    };
  }
  return {
    positionNo: String(p.position_no),
    funderName: p.funder_name,
    fundedAmount: centsToInput(p.funded_amount_cents),
    payback: centsToInput(p.payback_cents),
    balance: centsToInput(p.balance_cents),
    payment: centsToInput(p.payment_cents),
    frequency: p.frequency ?? "",
    fundedOn: p.funded_on ?? "",
    note: p.note,
  };
}

/** Client-side check for the one field whose server message is an unhelpful "Too small". */
export function positionError(f: PositionForm): string | null {
  const n = Number(f.positionNo);
  return Number.isInteger(n) && n >= 1 && n <= MAX_POSITION
    ? null
    : `Position must be a number from 1 to ${MAX_POSITION}`;
}

export function positionPayload(clientId: string, f: PositionForm, id?: string) {
  return {
    clientId,
    ...(id ? { id } : {}),
    ...f,
    frequency: f.frequency || null,
    fundedOn: f.fundedOn || null,
  };
}

export interface OfferForm {
  funderName: string;
  amount: string;
  factorRate: string;
  payment: string;
  frequency: Frequency | "";
  positionNo: string;
  termDays: string;
  offeredOn: string;
  won: boolean;
  note: string;
}

export function offerForm(o: OfferRow | undefined, today: ISODate): OfferForm {
  if (!o) {
    return {
      funderName: "",
      amount: "",
      factorRate: "",
      payment: "",
      frequency: "",
      positionNo: "",
      termDays: "",
      offeredOn: today,
      won: false,
      note: "",
    };
  }
  return {
    funderName: o.funder_name,
    amount: centsToInput(o.amount_cents),
    factorRate: o.factor_rate === null ? "" : formatFactor(o.factor_rate),
    payment: centsToInput(o.payment_cents),
    frequency: o.frequency ?? "",
    positionNo: intToInput(o.position_no),
    termDays: intToInput(o.term_days),
    offeredOn: o.offered_on,
    won: o.won,
    note: o.note,
  };
}

export function offerPayload(clientId: string, f: OfferForm, id?: string) {
  return {
    clientId,
    ...(id ? { id } : {}),
    ...f,
    frequency: f.frequency || null,
    offeredOn: f.offeredOn || undefined,
  };
}

export interface FundingForm {
  paidBackOverride: string;
  lastPaymentOn: string;
  promiseToPayAt: string;
  promiseAmount: string;
  note: string;
}

export function fundingForm(f: FundingRow, timezone: string): FundingForm {
  return {
    paidBackOverride: centsToInput(f.paid_back_override_cents),
    lastPaymentOn: f.last_payment_on ?? "",
    promiseToPayAt: f.promise_to_pay_at ? toLocalInput(f.promise_to_pay_at, timezone) : "",
    promiseAmount: centsToInput(f.promise_amount_cents),
    note: f.note,
  };
}

export function fundingPayload(fundingId: string, f: FundingForm) {
  return {
    fundingId,
    ...f,
    lastPaymentOn: f.lastPaymentOn || null,
    promiseToPayAt: f.promiseToPayAt || null,
  };
}
