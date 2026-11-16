import type { ISODate } from "../mca/dates";

export const DEAL_KINDS = ["new", "reshop", "renewal", "add_on"] as const;
export type DealKind = (typeof DEAL_KINDS)[number];
export const DEAL_KIND_LABELS: Record<DealKind, string> = {
  new: "New deal",
  reshop: "Reshop",
  renewal: "Renewal",
  add_on: "Add-on",
};

export const OPS_STATUSES = ["queued", "kicked_back", "sent", "closed"] as const;
export type OpsStatus = (typeof OPS_STATUSES)[number];

export const OUTCOMES = ["open", "funded", "declined", "dead", "lost"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Why ops sent a file back. The pick-list; "other" needs a note. */
export const KICKBACK_REASONS = [
  "unsigned_application",
  "missing_statement_month",
  "statements_not_newest",
  "missing_ein_ssn_dob",
  "ownership_mismatch",
  "illegible_id",
  "duplicate_merchant",
  "wrong_bank_statements",
  "other",
] as const;
export type KickbackReason = (typeof KICKBACK_REASONS)[number];
export const KICKBACK_LABELS: Record<KickbackReason, string> = {
  unsigned_application: "Application not signed",
  missing_statement_month: "A statement month is missing",
  statements_not_newest: "Statements are not the newest month",
  missing_ein_ssn_dob: "Missing EIN, SSN or date of birth",
  ownership_mismatch: "Owner on the app doesn't match the statements",
  illegible_id: "ID is not legible",
  duplicate_merchant: "Duplicate merchant",
  wrong_bank_statements: "Wrong bank account's statements",
  other: "Other",
};

/**
 * Deal status is derived in SQL (app.deal_status) from the lender rows and the ops loop. These are its values,
 * in the order the Submission Board shows them. One list; every filter chip reads it.
 */
export const DEAL_STATUSES = [
  "working",
  "working_ops",
  "kicked_back",
  "pending_lenders",
  "stips_needed",
  "needs_pitch",
  "pitched",
  "contracts_out",
  "contracts_in",
  "funding_call",
  "funded",
  "declined_by_all",
  "declined",
  "lost",
  "dead",
] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];
export const DEAL_STATUS_LABELS: Record<DealStatus, string> = {
  working: "Working",
  working_ops: "With ops",
  kicked_back: "Kicked back",
  pending_lenders: "Pending lenders",
  stips_needed: "Stips needed",
  needs_pitch: "Needs pitch",
  pitched: "Pitched",
  contracts_out: "Contracts out",
  contracts_in: "Contracts in",
  funding_call: "Funding call",
  funded: "Funded",
  declined_by_all: "Declined by all",
  declined: "Declined",
  lost: "Lost",
  dead: "Dead",
};

/** Statuses a rep still has money in. */
export const LIVE_STATUSES: readonly DealStatus[] = [
  "working",
  "working_ops",
  "kicked_back",
  "pending_lenders",
  "stips_needed",
  "needs_pitch",
  "pitched",
  "contracts_out",
  "contracts_in",
  "funding_call",
];

export interface DealRow {
  id: string;
  number: number;
  user_id: string;
  client_id: string;
  kind: DealKind;
  requested_cents: number | null;
  use_of_funds: string;
  ops_status: OpsStatus;
  ops_owner: string | null;
  queued_at: string;
  kicked_back_at: string | null;
  kickback_reason: KickbackReason | null;
  kickback_note: string;
  kickback_count: number;
  sent_at: string | null;
  outcome: Outcome;
  outcome_reason: string;
  closed_at: string | null;
  blocker: string;
  rep_note: string;
  manager_note: string;
  ops_note: string;
  created_at: string;
  updated_at: string;
  /** Derived: app.deal_status(). */
  status: DealStatus;
}

/** One line on a board or a list: the deal plus what a glance needs from the merchant and the lender rows. */
export interface DealCard extends DealRow {
  business_name: string;
  contact_name: string;
  phone: string;
  email: string;
  industry: string;
  state: string;
  stage: string;
  rep_name: string;
  rep_email: string;
  lenders_sent: number;
  lenders_responded: number;
  lenders_approved: number;
  lenders_declined: number;
  /** Best live offer, if any. */
  best_offer_cents: number | null;
  best_factor_rate: number | null;
  /** Soonest approval expiry among live approvals. */
  approval_expires_on: ISODate | null;
  funded_cents: number | null;
  commission_cents: number | null;
  last_activity_at: string | null;
}

export type DealFilter =
  "all" | "mine" | "live" | DealStatus | "expiring" | "no_response_24h" | "reshop";
