import type { ISODate } from "../mca/dates";
import type { Frequency } from "../mca/funding";
import type { ContactStatus } from "../mca/contact";
import type { StageKey, TimerKind } from "../mca/stages";
import type { StipKind } from "../mca/stips";
import type { TouchOutcome } from "../mca/touch";

/** Timestamps are ISO strings and dates are "YYYY-MM-DD" — rows come out of Postgres as JSON. */
export interface ClientCard {
  id: string;
  business_name: string;
  dba: string;
  contact_name: string;
  phone: string;
  email: string;
  industry: string;
  state: string;
  source: string;
  monthly_revenue_cents: number | null;
  time_in_business_months: number | null;
  stage: StageKey;
  stage_changed_at: string;
  application_received_on: ISODate | null;
  scheduled_call_at: string | null;
  last_contact_at: string | null;
  contact_status: ContactStatus;
  contact_status_note: string;
  contact_status_at: string | null;
  created_at: string;
  next_due_on: ISODate | null;
  next_due_kind: TimerKind | null;
  last_call_at: string | null;
  last_touch_at: string | null;
  last_call_note: string | null;
  wanted_amount_cents: number | null;
  wanted_terms: string | null;
  est_approval_cents: number | null;
  est_approval_note: string | null;
  position_count: number;
  position_balance_cents: number;
  stips_required: number;
  stips_received: number;
  funding_id: string | null;
  funded_on: ISODate | null;
  funding_amount_cents: number | null;
  factor_rate: number | null;
  funding_payback_cents: number | null;
  funding_payment_cents: number | null;
  funding_frequency: Frequency | null;
  paid_back_override_cents: number | null;
  funding_status: "active" | "paid_off" | "defaulted" | "renewed" | null;
  defaulted_on: ISODate | null;
  last_payment_on: ISODate | null;
  promise_to_pay_at: string | null;
  promise_amount_cents: number | null;
}

export interface ActivityRow {
  id: string;
  client_id: string;
  kind: "note" | "call" | "text" | "email" | "stage_change" | "timer" | "funding" | "system";
  outcome: TouchOutcome | null;
  body: string;
  from_stage: StageKey | null;
  to_stage: StageKey | null;
  occurred_at: string;
}

export interface PositionRow {
  id: string;
  position_no: number;
  funder_name: string;
  funded_amount_cents: number;
  payback_cents: number | null;
  balance_cents: number;
  payment_cents: number | null;
  frequency: Frequency | null;
  funded_on: ISODate | null;
  note: string;
}

export interface OfferRow {
  id: string;
  funder_name: string;
  amount_cents: number | null;
  factor_rate: number | null;
  payment_cents: number | null;
  frequency: Frequency | null;
  position_no: number | null;
  term_days: number | null;
  offered_on: ISODate;
  won: boolean;
  note: string;
}

export interface AskRow {
  id: string;
  wanted_amount_cents: number | null;
  wanted_terms: string;
  est_approval_cents: number | null;
  est_approval_note: string;
  created_at: string;
}

export interface StipRow {
  id: string;
  kind: StipKind;
  period: ISODate | null;
  required: boolean;
  received_at: string | null;
}

export interface FundingRow {
  id: string;
  funded_on: ISODate;
  funder_name: string;
  amount_cents: number;
  factor_rate: number;
  payback_cents: number;
  payment_cents: number;
  frequency: Frequency;
  position_no: number;
  term_days: number | null;
  commission_cents: number | null;
  paid_back_override_cents: number | null;
  status: "active" | "paid_off" | "defaulted" | "renewed";
  defaulted_on: ISODate | null;
  last_payment_on: ISODate | null;
  promise_to_pay_at: string | null;
  promise_amount_cents: number | null;
  commission_received_cents?: number | null;
  commission_received_on?: ISODate | null;
  note: string;
}

export interface TimerRow {
  id: string;
  kind: TimerKind;
  due_on: ISODate;
  note: string;
}

export interface ClientDetail {
  card: ClientCard;
  activities: ActivityRow[];
  positions: PositionRow[];
  offers: OfferRow[];
  asks: AskRow[];
  stips: StipRow[];
  fundings: FundingRow[];
  timers: TimerRow[];
}

export interface UserContext {
  today: ISODate;
  timezone: string;
}

export interface ActionOk<T> {
  ok: true;
  data: T;
}
export interface ActionErr {
  ok: false;
  error: string;
  /** The Gmail grant is dead — show the reconnect prompt. */
  reconnect?: boolean;
}
export type ActionResult<T> = ActionOk<T> | ActionErr;
