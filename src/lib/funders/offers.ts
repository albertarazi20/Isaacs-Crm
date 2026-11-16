import { diffDays, type ISODate } from "../mca/dates";
import { paybackCents } from "../mca/funding";
import type { Frequency } from "../mca/funding";
import { formatMoneyCompact } from "../money";
import { factorText, ordinal } from "./format";
import type { FunderOfferRow, SubmissionRow, SubmissionStatus } from "./types";

/** An offer still in play: the merchant could take it, or already did. */
export const isLiveOffer = (o: Pick<FunderOfferRow, "status">): boolean =>
  o.status === "open" || o.status === "presented" || o.status === "accepted";

/** Lowest factor rate wins; a tie goes to the bigger advance, then the earlier offer. */
export function bestOffer<T extends Pick<FunderOfferRow, "factor_rate" | "amount_cents">>(
  offers: readonly T[],
): T | null {
  let best: T | null = null;
  for (const o of offers) {
    if (
      best === null ||
      o.factor_rate < best.factor_rate ||
      (o.factor_rate === best.factor_rate && o.amount_cents > best.amount_cents)
    )
      best = o;
  }
  return best;
}

export const FREQUENCY_WORD: Record<Frequency, string> = {
  daily: "daily",
  weekly: "weekly",
  biweekly: "every 2 weeks",
  monthly: "monthly",
};

export interface OfferChip {
  offerId: string;
  funderName: string;
  /** "1.34 / $45k daily" */
  text: string;
  best: boolean;
}

/**
 * The one-line "offers in" summary: every live offer across the submissions, best first.
 * Only the lowest factor is flagged, and only when there is something to compare it with.
 */
export function offerChips(submissions: readonly SubmissionRow[]): OfferChip[] {
  const live = submissions.flatMap((s) =>
    s.offers.filter(isLiveOffer).map((o) => ({ o, name: s.funder_name })),
  );
  const top = bestOffer(live.map((x) => x.o));
  return live
    .map(({ o, name }) => ({
      offerId: o.id,
      funderName: name,
      factor: o.factor_rate,
      amount: o.amount_cents,
      text: `${factorText(o.factor_rate)} / ${formatMoneyCompact(o.amount_cents)}${o.frequency ? ` ${FREQUENCY_WORD[o.frequency]}` : ""}`,
      best: live.length > 1 && top !== null && o.id === top.id,
    }))
    .sort((a, b) => a.factor - b.factor || b.amount - a.amount)
    .map(({ offerId, funderName, text, best }) => ({ offerId, funderName, text, best }));
}

export function paybackOf(o: Pick<FunderOfferRow, "amount_cents" | "factor_rate">): number {
  return paybackCents(o.amount_cents, o.factor_rate);
}

/** Offer compare maths (S2-11), one row per offer, computed server-side so every page agrees. */
export interface OfferMath {
  offerId: string;
  funderName: string;
  amountCents: number;
  factorRate: number;
  paybackCents: number;
  /** Payback minus the advance: what the money costs the merchant. */
  costCents: number;
  paymentCents: number | null;
  frequency: Frequency | null;
  /** How many remittances it takes: payback ÷ payment, else from the term; null when neither is known. */
  paymentCount: number | null;
  feesCents: number;
  /** The advance minus the lender's fees: what reaches the merchant's account. */
  netToMerchantCents: number;
  commissionPoints: number | null;
  /** Our commission at the lender's points on the advance; null when the lender's points are unknown. */
  commissionCents: number | null;
  /** The lowest factor rate, when there is something to compare it with. */
  best: boolean;
}

export type OfferForMath = Pick<
  FunderOfferRow,
  "id" | "amount_cents" | "factor_rate" | "payment_cents" | "frequency" | "term_days" | "fees_cents"
> & { funder_name: string; commission_points: number | null };

const PER_TERM: Record<Frequency, (termDays: number) => number> = {
  daily: (d) => Math.round((d * 5) / 7),
  weekly: (d) => Math.round(d / 7),
  biweekly: (d) => Math.round(d / 14),
  monthly: (d) => Math.round(d / 30.4),
};

export function compareOffers(offers: readonly OfferForMath[]): OfferMath[] {
  const top = bestOffer(offers);
  return offers
    .map((o) => {
      const payback = paybackOf(o);
      const fees = o.fees_cents ?? 0;
      const count =
        o.payment_cents !== null && o.payment_cents > 0
          ? Math.ceil(payback / o.payment_cents)
          : o.term_days !== null && o.frequency !== null
            ? Math.max(1, PER_TERM[o.frequency](o.term_days))
            : null;
      return {
        offerId: o.id,
        funderName: o.funder_name,
        amountCents: o.amount_cents,
        factorRate: o.factor_rate,
        paybackCents: payback,
        costCents: payback - o.amount_cents,
        paymentCents: o.payment_cents,
        frequency: o.frequency,
        paymentCount: count,
        feesCents: fees,
        netToMerchantCents: o.amount_cents - fees,
        commissionPoints: o.commission_points,
        commissionCents:
          o.commission_points !== null
            ? Math.round((o.amount_cents * o.commission_points) / 100)
            : null,
        best: offers.length > 1 && top !== null && o.id === top.id,
      };
    })
    .sort((a, b) => a.factorRate - b.factorRate || b.amountCents - a.amountCents);
}

export type SubmissionAction =
  | "approved"
  | "declined"
  | "stips_requested"
  | "no_response"
  | "withdrawn"
  | "reopen"
  | "stips_sent"
  | "add_offer"
  | "contracts_out"
  | "contracts_in"
  | "funding_call";

/**
 * Which buttons a submission row offers, by where it stands. Every status in the database's check
 * (0300) has an entry — a row the card cannot render would take the whole page down. Funded is the
 * end of the line (FUND wrote it; nothing here undoes money), so it is a chip only.
 */
export const SUBMISSION_ACTIONS: Record<SubmissionStatus, readonly SubmissionAction[]> = {
  sent: ["approved", "declined", "stips_requested", "no_response", "withdrawn"],
  stips_requested: ["stips_sent", "approved", "declined", "withdrawn"],
  approved: ["add_offer", "contracts_out", "declined", "reopen"],
  revised: ["add_offer", "contracts_out", "declined", "reopen"],
  contracts_out: ["contracts_in", "declined", "withdrawn"],
  contracts_in: ["funding_call", "declined", "withdrawn"],
  funding_call: ["declined", "withdrawn"],
  funded: [],
  declined: ["approved", "reopen"],
  no_response: ["approved", "declined", "reopen"],
  withdrawn: ["reopen"],
  expired: ["reopen"],
};

/** The actions that are a plain status change (no dialog first). */
export type PlainAction =
  | "no_response"
  | "withdrawn"
  | "reopen"
  | "stips_sent"
  | "contracts_out"
  | "contracts_in"
  | "funding_call";

/** The status each plain action writes. */
export const PLAIN_STATUS_ACTIONS: Record<PlainAction, SubmissionStatus> = {
  no_response: "no_response",
  withdrawn: "withdrawn",
  reopen: "sent",
  stips_sent: "sent",
  contracts_out: "contracts_out",
  contracts_in: "contracts_in",
  funding_call: "funding_call",
};

export const isPlainAction = (a: SubmissionAction): a is PlainAction =>
  Object.hasOwn(PLAIN_STATUS_ACTIONS, a);

/** "$45,000 at 1.34 factor · payback $60,300 · $450 daily" — the money terms of an offer, in MCA words. */
export function offerTerms(
  o: Pick<FunderOfferRow, "amount_cents" | "factor_rate" | "payment_cents" | "frequency">,
  money: (cents: number) => string,
): string {
  const parts = [
    `${money(o.amount_cents)} at ${factorText(o.factor_rate)} factor`,
    `payback ${money(paybackOf(o))}`,
  ];
  if (o.payment_cents !== null)
    parts.push(`${money(o.payment_cents)}${o.frequency ? ` ${FREQUENCY_WORD[o.frequency]}` : ""}`);
  return parts.join(" · ");
}

/** "2nd position · 130-day term · $500 fees" — what else the offer says; empty when it says nothing more. */
export function offerExtras(
  o: Pick<FunderOfferRow, "position_no" | "term_days" | "fees_cents">,
  money: (cents: number) => string,
): string {
  const parts: string[] = [];
  if (o.position_no !== null) parts.push(`${ordinal(o.position_no)} position`);
  if (o.term_days !== null) parts.push(`${o.term_days}-day term`);
  if (o.fees_cents !== null) parts.push(`${money(o.fees_cents)} fees`);
  return parts.join(" · ");
}

/**
 * How long the funder has had it, or how fast they answered. `days` is calendar days; `today`
 * is Isaac's today. Closed-out rows (no response, withdrawn) just say when they were sent.
 */
export function waitText(
  s: Pick<SubmissionRow, "status" | "sent_on" | "responded_on">,
  today: ISODate,
): string {
  if (s.responded_on !== null) {
    const days = Math.max(0, diffDays(s.sent_on, s.responded_on));
    return days === 0
      ? "Answered the same day"
      : `Answered in ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (s.status === "sent" || s.status === "stips_requested") {
    const days = Math.max(0, diffDays(s.sent_on, today));
    return days === 0 ? "Sent today" : `Waiting ${days} ${days === 1 ? "day" : "days"}`;
  }
  return "";
}

/** The newest submission to each funder, so the Send list can say "already sent Oct 20 — declined". */
export function latestByFunder(submissions: readonly SubmissionRow[]): Map<string, SubmissionRow> {
  const out = new Map<string, SubmissionRow>();
  for (const s of submissions) {
    const cur = out.get(s.funder_id);
    if (
      !cur ||
      s.sent_on > cur.sent_on ||
      (s.sent_on === cur.sent_on && s.status_changed_at > cur.status_changed_at)
    )
      out.set(s.funder_id, s);
  }
  return out;
}

/** Still in play with that funder: waiting on them, they want stips, they said yes, or the deal is closing. */
export const isLiveSubmission = (s: Pick<SubmissionRow, "status">): boolean =>
  s.status === "sent" ||
  s.status === "stips_requested" ||
  s.status === "approved" ||
  s.status === "revised" ||
  s.status === "contracts_out" ||
  s.status === "contracts_in" ||
  s.status === "funding_call";
