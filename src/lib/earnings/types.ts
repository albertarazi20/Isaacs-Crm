import type { ContactStatus } from "../mca/contact";
import type { ISODate } from "../mca/dates";
import type { Frequency, FundingTerms } from "../mca/funding";
import type { StageKey } from "../mca/stages";

export type AdvanceStatus = "active" | "paid_off" | "defaulted" | "renewed";

/** One funded advance together with the merchant it belongs to — the shape every earnings page works from. */
export interface AdvanceRow {
  id: string;
  clientId: string;
  businessName: string;
  industry: string;
  stage: StageKey;
  contactStatus: ContactStatus;
  fundedOn: ISODate;
  funderName: string;
  amountCents: number;
  factorRate: number;
  paybackCents: number;
  paymentCents: number;
  frequency: Frequency;
  positionNo: number;
  termDays: number | null;
  /** What the shop expects to earn on this advance, as entered by hand. */
  commissionCents: number | null;
  /** What the funder actually paid, entered by hand, with the day it arrived. */
  commissionReceivedCents: number | null;
  commissionReceivedOn: ISODate | null;
  paidBackOverrideCents: number | null;
  status: AdvanceStatus;
}

export function advanceTerms(a: AdvanceRow): FundingTerms {
  return {
    fundedOn: a.fundedOn,
    amountCents: a.amountCents,
    factorRate: a.factorRate,
    paymentCents: a.paymentCents,
    frequency: a.frequency,
    paidBackOverrideCents: a.paidBackOverrideCents,
  };
}

/** A funder's own figures, from the Funders page (migration 0010). Matched to an advance by name. */
export interface FunderTerms {
  name: string;
  commissionPoints: number | null;
  renewalPaydownPct: number | null;
}

/** A live offer on a deal that has not funded yet. */
export interface OfferRow {
  id: string;
  clientId: string;
  funderName: string;
  amountCents: number;
  factorRate: number;
  positionNo: number | null;
  status: "open" | "presented" | "accepted" | "declined" | "expired";
  receivedOn: ISODate;
}

/** What another funder offered the merchant (the competing offers logged on a lost deal). */
export interface CompetingOfferRow {
  id: string;
  clientId: string;
  businessName: string;
  industry: string;
  funderName: string;
  amountCents: number | null;
  factorRate: number | null;
  positionNo: number | null;
  /** True when the merchant took it. */
  won: boolean;
}

/** A deal that has not funded: what the pipeline forecast needs to know about it. */
export interface DealRow {
  id: string;
  businessName: string;
  stage: StageKey;
  estApprovalCents: number | null;
}
