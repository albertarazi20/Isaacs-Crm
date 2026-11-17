import type { ISODate } from "../mca/dates";
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
  /** What the booked reminder is for: call, text or email. Null when nothing is booked. */
  reminder_channel?: "call" | "text" | "email" | null;
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
  stips_required: number;
  stips_received: number;
}

export interface ActivityRow {
  id: string;
  client_id: string;
  kind: "note" | "call" | "text" | "email" | "stage_change" | "timer" | "system";
  outcome: TouchOutcome | null;
  body: string;
  from_stage: StageKey | null;
  to_stage: StageKey | null;
  occurred_at: string;
}

export interface StipRow {
  id: string;
  kind: StipKind;
  period: ISODate | null;
  required: boolean;
  received_at: string | null;
}

export interface TimerRow {
  id: string;
  kind: TimerKind;
  due_on: ISODate;
  note: string;
}

/**
 * Where a merchant stands on the way in (the merchant page's header and "Bringing them in" strip): who owns it, the
 * bucket it sits in, whether it wrote back, and the hand-off (clients.brought_in_at / brought_in_by, migration 0540).
 */
export interface ClientBringIn {
  /** When the rep handed the merchant off; null while it is still being brought in. */
  brought_in_at: string | null;
  brought_in_by: string | null;
  /** The name of whoever pressed Hand off ("" when unknown). */
  brought_in_by_name: string;
  /** The rep whose merchant this is ("" when the name is not set). */
  owner_name: string;
  /** The bucket it is enrolled in right now, or null when it is in none. */
  bucket_name: string | null;
  /** The merchant's latest reply, or null when they never wrote back. */
  replied_at: string | null;
  /** Set while a reply is still waiting on an answer. */
  reply_waiting_since: string | null;
}

export interface ClientDetail {
  card: ClientCard;
  activities: ActivityRow[];
  stips: StipRow[];
  timers: TimerRow[];
  bringIn: ClientBringIn;
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
