import type { ISODate } from "../mca/dates";
import type { Frequency } from "../mca/funding";

/** Every value `submissions.status` may hold (the check constraint in db/migrations/0300_deals.sql). */
export const SUBMISSION_STATUSES = [
  "sent",
  "stips_requested",
  "approved",
  "revised",
  "declined",
  "no_response",
  "withdrawn",
  "contracts_out",
  "contracts_in",
  "funding_call",
  "funded",
  "expired",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  sent: "Sent",
  stips_requested: "Stips requested",
  approved: "Approved",
  revised: "Revised offer",
  declined: "Declined",
  no_response: "No response",
  withdrawn: "Withdrawn",
  contracts_out: "Contracts out",
  contracts_in: "Contracts in",
  funding_call: "Funding call",
  funded: "Funded",
  expired: "Expired",
};

/**
 * The keys the `decline_reasons` table holds (0300). The pick-lists read the table itself — this list only types a
 * stored reason and gives a stored one its label when the table rows are not on the page.
 */
export const DECLINE_REASONS = [
  "revenue",
  "falling_revenue",
  "low_balances",
  "negative_days",
  "nsfs",
  "position",
  "over_leveraged",
  "recently_funded",
  "time_in_business",
  "industry",
  "state",
  "credit",
  "lien",
  "bankruptcy",
  "stips",
  "failed_bv",
  "altered_statements",
  "prior_default",
  "other",
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

export const DECLINE_REASON_LABELS: Record<DeclineReason, string> = {
  revenue: "Revenue too low",
  falling_revenue: "Revenue falling",
  low_balances: "Low daily balances",
  negative_days: "Too many negative days",
  nsfs: "Too many NSFs",
  position: "Too many positions",
  over_leveraged: "Over-leveraged",
  recently_funded: "Funded too recently",
  time_in_business: "Time in business",
  industry: "Restricted industry",
  state: "Restricted state",
  credit: "Credit",
  lien: "Tax lien",
  bankruptcy: "Bankruptcy",
  stips: "Stips never came in",
  failed_bv: "Failed bank verification",
  altered_statements: "Suspected altered statements",
  prior_default: "Prior default",
  other: "Other",
};

export const DECLINE_CATEGORIES = [
  "bank_health",
  "debt_load",
  "profile",
  "credit",
  "file",
  "history",
  "other",
] as const;
export type DeclineCategory = (typeof DECLINE_CATEGORIES)[number];
export const DECLINE_CATEGORY_LABELS: Record<DeclineCategory, string> = {
  bank_health: "Bank health",
  debt_load: "Debt load",
  profile: "Business profile",
  credit: "Credit and background",
  file: "The file",
  history: "History",
  other: "Other",
};

/** One row of `decline_reasons`, as the decline pick-lists read it. */
export interface DeclineReasonRow {
  key: string;
  label: string;
  category: DeclineCategory;
  /** Days until the reason usually stops applying (Winback's clock); null = not curable on a clock. */
  curable_after_days: number | null;
  sort: number;
}

export const OFFER_STATUSES = ["open", "presented", "accepted", "declined", "expired"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  open: "New",
  presented: "Presented",
  accepted: "Accepted",
  declined: "Turned down",
  expired: "Expired",
};

/** A funder and what it will and won't write. Null means "no limit" or "not known". */
export interface FunderRow {
  id: string;
  name: string;
  submission_email: string;
  contact_name: string;
  phone: string;
  notes: string;
  active: boolean;
  min_monthly_revenue_cents: number | null;
  min_time_in_business_months: number | null;
  max_position: number | null;
  min_amount_cents: number | null;
  max_amount_cents: number | null;
  excluded_states: string[];
  excluded_industries: string[];
  commission_points: number | null;
  renewal_paydown_pct: number | null;
  /** Money terms (0350): what FUND's guardrails check this lender's deals against. */
  max_upsell_points: number | null;
  psf_cap_pct: number | null;
  clawback_days: number;
  /** null = this lender follows the shop's default (Settings → Email & lenders). */
  approval_valid_days: number | null;
  statement_fresh_day: number;
  commission_paid_after_days: number;
  renewal_commission_basis: RenewalCommissionBasis;
  created_at: string;
}

export const RENEWAL_COMMISSION_BASES = ["new_money", "full"] as const;
export type RenewalCommissionBasis = (typeof RENEWAL_COMMISSION_BASES)[number];
export const RENEWAL_COMMISSION_BASIS_LABELS: Record<RenewalCommissionBasis, string> = {
  new_money: "New money only",
  full: "The full renewal",
};

/** The money terms' defaults, the same as the columns' defaults in 0350. A blank box in the form means these. */
export const MONEY_TERM_DEFAULTS = {
  clawback_days: 30,
  approval_valid_days: 30,
  statement_fresh_day: 5,
  commission_paid_after_days: 7,
  renewal_commission_basis: "new_money",
} as const satisfies Pick<
  FunderRow,
  | "clawback_days"
  | "approval_valid_days"
  | "statement_fresh_day"
  | "commission_paid_after_days"
  | "renewal_commission_basis"
>;

/** What one of OUR funders offered. (competing_offers is what other funders offered the merchant.) */
export interface FunderOfferRow {
  id: string;
  submission_id: string;
  client_id: string;
  amount_cents: number;
  factor_rate: number;
  payment_cents: number | null;
  frequency: Frequency | null;
  term_days: number | null;
  position_no: number | null;
  fees_cents: number | null;
  note: string;
  received_on: ISODate;
  status: OfferStatus;
}

export interface SubmissionRow {
  id: string;
  client_id: string;
  funder_id: string;
  funder_name: string;
  sent_on: ISODate;
  status: SubmissionStatus;
  decline_reason: DeclineReason | null;
  decline_note: string;
  note: string;
  status_changed_at: string;
  /** The day the funder first answered, in Isaac's timezone. */
  responded_on: ISODate | null;
  /** When the open chase timer is due (null once the funder has answered). */
  chase_due_on: ISODate | null;
  offers: FunderOfferRow[];
}

/** Everything the client page needs to show the Submissions card. */
export interface ClientFundersData {
  funders: FunderRow[];
  submissions: SubmissionRow[];
  /** The `decline_reasons` table, for the decline pick-list. */
  declineReasons: DeclineReasonRow[];
  /** The merchant's open deal (the ops loop), if there is one. */
  deal: OpenDeal | null;
}

/** What the Submissions card needs to know about the merchant's open deal. */
export interface OpenDeal {
  id: string;
  number: number;
  kind: string;
  ops_status: "queued" | "kicked_back" | "sent" | "closed";
  kickback_reason: string | null;
  kickback_note: string;
  /** app.deal_status(): the label the deal page shows. */
  status: string;
}
