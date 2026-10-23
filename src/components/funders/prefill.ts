import type { FunderOfferRow, FunderRow } from "@/lib/funders/types";
import { centsToInput, type FundingPrefill } from "../stage-move/forms";

/**
 * The Funded dialog's starting values for an accepted offer: amount, factor rate, remittance, how
 * often, term, position and the funder's name. When the funder has commission points on file the
 * commission is worked out from them (points × advance), so it is one less number to type.
 */
export function offerToFundingPrefill(
  offer: Pick<
    FunderOfferRow,
    "amount_cents" | "factor_rate" | "payment_cents" | "frequency" | "term_days" | "position_no"
  >,
  funderName: string,
  funder: Pick<FunderRow, "commission_points"> | null,
  nextPosition: number,
): FundingPrefill {
  const out: FundingPrefill = {
    amount: centsToInput(offer.amount_cents),
    factorRate: String(offer.factor_rate),
    payment: centsToInput(offer.payment_cents),
    funderName,
    positionNo: String(offer.position_no ?? nextPosition),
    termDays: offer.term_days === null ? "" : String(offer.term_days),
  };
  if (offer.frequency !== null) out.frequency = offer.frequency;
  if (funder?.commission_points != null) {
    out.commission = centsToInput(
      Math.round((offer.amount_cents * funder.commission_points) / 100),
    );
  }
  return out;
}
