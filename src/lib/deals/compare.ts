import { compareOffers, isLiveOffer, type OfferMath } from "../funders/offers";
import type { FunderRow, SubmissionRow } from "../funders/types";

/** A lender row as the funders query returns it: the row's JSON carries `deal_id` though the type does not list it. */
type DealSubmission = SubmissionRow & { deal_id?: string | null };

/**
 * The offer-compare table for one deal (S2-11): every offer still in play on the deal's lender rows, with the
 * server-side maths (payback, payment count, net to merchant, our commission at the lender's points) and the best
 * one flagged. Pure: the page hands it the rows it already loaded.
 */
export function dealOfferMath(
  submissions: readonly DealSubmission[],
  funders: readonly Pick<FunderRow, "id" | "commission_points">[],
  dealId: string,
): OfferMath[] {
  const points = new Map(funders.map((f) => [f.id, f.commission_points]));
  return compareOffers(
    submissions
      .filter((s) => s.deal_id == null || s.deal_id === dealId)
      .flatMap((s) =>
        s.offers.filter(isLiveOffer).map((o) => ({
          id: o.id,
          amount_cents: o.amount_cents,
          factor_rate: o.factor_rate,
          payment_cents: o.payment_cents,
          frequency: o.frequency,
          term_days: o.term_days,
          fees_cents: o.fees_cents,
          funder_name: s.funder_name,
          commission_points: points.get(s.funder_id) ?? null,
        })),
      ),
  );
}
