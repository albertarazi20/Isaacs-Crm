import type { ISODate } from "../mca/dates";
import type { Frequency } from "../mca/funding";

export const SUBMISSION_STATUSES = [
  "sent",
  "stips_requested",
  "approved",
  "declined",
  "no_response",
  "withdrawn",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  sent: "Sent",
  stips_requested: "Stips requested",
  approved: "Approved",
  declined: "Declined",
  no_response: "No response",
  withdrawn: "Withdrawn",
};

export const DECLINE_REASONS = [
  "revenue",
  "time_in_business",
  "nsfs",
  "position",
  "industry",
  "state",
  "credit",
  "stips",
  "over_leveraged",
  "other",
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

export const DECLINE_REASON_LABELS: Record<DeclineReason, string> = {
  revenue: "Revenue too low",
  time_in_business: "Not enough time in business",
  nsfs: "Too many NSFs",
  position: "Position",
  industry: "Industry",
  state: "State",
  credit: "Credit",
  stips: "Stips",
  over_leveraged: "Over-leveraged",
  other: "Other",
};

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
  created_at: string;
}

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
}
