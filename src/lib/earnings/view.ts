import { type ISODate } from "../mca/dates";
import {
  averagePoints,
  funderKey,
  type AveragePoints,
  type CommissionContext,
  type FunderPoints,
} from "./commission";
import { earnedSummary, monthRows, type EarnedSummary, type MonthRow } from "./earned";
import {
  awaitingCommission,
  pipelineDeals,
  renewalForecast,
  type Awaiting,
  type Pipeline,
  type RenewalForecast,
} from "./expected";
import { lossGap, lostDeals, observations, type LossGap, type PriceObservation } from "./pricebook";
import { funderThresholdMap } from "./progress";
import type { EarningsData } from "./queries";
import type { FunderTerms } from "./types";

export function funderPointsMap(funders: readonly FunderTerms[]): FunderPoints {
  const m = new Map<string, number>();
  for (const f of funders)
    if (f.commissionPoints !== null) m.set(funderKey(f.name), f.commissionPoints);
  return m;
}

/** The commission context every page shares: his own average points, and each funder's points when known. */
export function commissionContext(
  data: Pick<EarningsData, "advances" | "funders">,
): CommissionContext {
  return { average: averagePoints(data.advances), funderPoints: funderPointsMap(data.funders) };
}

export interface EarningsView {
  today: ISODate;
  summary: EarnedSummary;
  months: MonthRow[];
  average: AveragePoints | null;
  advanceCount: number;
  awaiting: Awaiting;
  pipeline: Pipeline;
  renewals: RenewalForecast;
  price: {
    observations: PriceObservation[];
    loss: LossGap;
    hasOffers: boolean;
  };
}

export function buildEarnings(data: EarningsData, today: ISODate): EarningsView {
  const ctx = commissionContext(data);
  return {
    today,
    summary: earnedSummary(data.advances, today),
    months: monthRows(data.advances, today, 12),
    average: ctx.average,
    advanceCount: data.advances.length,
    awaiting: awaitingCommission(data.advances, today, ctx),
    pipeline: pipelineDeals(data.deals, data.offers, ctx),
    renewals: renewalForecast(
      data.advances,
      today,
      ctx,
      funderThresholdMap(data.funders),
      null,
      data.cards,
    ),
    price: {
      observations: observations({
        advances: data.advances,
        offers: data.offers,
        competing: data.competing,
      }),
      loss: lossGap(lostDeals(data.competing, data.offers)),
      hasOffers: data.hasOffers,
    },
  };
}
