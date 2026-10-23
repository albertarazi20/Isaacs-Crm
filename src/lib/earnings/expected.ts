import type { ClientCard } from "../data/types";
import { addDays, diffDays, type ISODate } from "../mca/dates";
import {
  estimateCommission,
  expectedCommission,
  sumCommission,
  type CommissionAmount,
  type CommissionContext,
} from "./commission";
import { noExclusions, notRenewable, PIPELINE_STAGES, tally, type Excluded } from "./eligible";
import { advanceProgress, renewalThreshold, type FunderThresholds } from "./progress";
import type { AdvanceRow, DealRow, OfferRow } from "./types";

/** Commission is normally paid within weeks of funding; past this a missing entry is "not recorded", not "coming". */
export const AWAITING_WINDOW_DAYS = 90;

export { PIPELINE_STAGES };

// ---------------------------------------------------------------------------------------------
// (a) funded, commission not yet received

export interface AwaitingRow {
  advance: AdvanceRow;
  expected: CommissionAmount | null;
  daysSinceFunded: number;
}

export interface Awaiting {
  /** Funded in the last 90 days with nothing received yet: money that should still arrive. */
  recent: AwaitingRow[];
  /** Older, still nothing on record: probably just never entered, so NOT counted as coming. */
  older: AwaitingRow[];
  totalCents: number;
  unknown: number;
  estimated: number;
}

export function awaitingCommission(
  advances: readonly AdvanceRow[],
  today: ISODate,
  ctx: CommissionContext,
): Awaiting {
  const recent: AwaitingRow[] = [];
  const older: AwaitingRow[] = [];
  for (const advance of advances) {
    if (advance.commissionReceivedCents !== null || advance.status === "defaulted") continue;
    const row: AwaitingRow = {
      advance,
      expected: expectedCommission(advance, ctx),
      daysSinceFunded: Math.max(0, diffDays(advance.fundedOn, today)),
    };
    (row.daysSinceFunded <= AWAITING_WINDOW_DAYS ? recent : older).push(row);
  }
  const byDate = (a: AwaitingRow, b: AwaitingRow) => a.daysSinceFunded - b.daysSinceFunded;
  recent.sort(byDate);
  older.sort(byDate);
  const sum = sumCommission(recent.map((r) => r.expected));
  return { recent, older, totalCents: sum.cents, unknown: sum.unknown, estimated: sum.estimated };
}

// ---------------------------------------------------------------------------------------------
// (b) deals in the pipeline

export interface PipelineDeal {
  deal: DealRow;
  /** The amount the figure is based on, and where it came from. */
  amountCents: number | null;
  amountFrom: "offer" | "estimate" | null;
  /** The funder whose offer is the best one, when it came from an offer. */
  funderName: string | null;
  expected: CommissionAmount | null;
}

export interface Pipeline {
  deals: PipelineDeal[];
  totalCents: number;
  unknown: number;
}

const LIVE_OFFER = new Set<OfferRow["status"]>(["open", "presented", "accepted"]);

/**
 * Each deal at Offers in / Offer presented / Contract out is worth its BEST offer's commission (the funder's own
 * points if known, else his average points), or — with no offer logged — the amount he thinks the merchant will be
 * approved for × his average points. Both are estimates and the page says so.
 */
export function pipelineDeals(
  deals: readonly DealRow[],
  offers: readonly OfferRow[],
  ctx: CommissionContext,
): Pipeline {
  const live = new Map<string, OfferRow[]>();
  for (const o of offers) {
    if (!LIVE_OFFER.has(o.status)) continue;
    live.set(o.clientId, [...(live.get(o.clientId) ?? []), o]);
  }
  const out: PipelineDeal[] = [];
  for (const deal of deals) {
    if (!PIPELINE_STAGES.includes(deal.stage)) continue;
    const mine = live.get(deal.id) ?? [];
    if (mine.length > 0) {
      const scored = mine
        .map((o) => ({ o, c: estimateCommission(o.amountCents, o.funderName, ctx) }))
        // best = most commission; with no way to price commission, the biggest advance
        .sort(
          (a, b) => (b.c?.cents ?? -1) - (a.c?.cents ?? -1) || b.o.amountCents - a.o.amountCents,
        );
      const best = scored[0];
      if (best) {
        out.push({
          deal,
          amountCents: best.o.amountCents,
          amountFrom: "offer",
          funderName: best.o.funderName,
          expected: best.c,
        });
        continue;
      }
    }
    const est = deal.estApprovalCents;
    out.push({
      deal,
      amountCents: est !== null && est > 0 ? est : null,
      amountFrom: est !== null && est > 0 ? "estimate" : null,
      funderName: null,
      expected: est !== null && est > 0 ? estimateCommission(est, "", ctx) : null,
    });
  }
  out.sort(
    (a, b) =>
      (b.expected?.cents ?? -1) - (a.expected?.cents ?? -1) ||
      a.deal.businessName.localeCompare(b.deal.businessName),
  );
  const sum = sumCommission(out.map((d) => d.expected));
  return { deals: out, totalCents: sum.cents, unknown: sum.unknown };
}

// ---------------------------------------------------------------------------------------------
// (c) renewals still to come

export type Horizon = "now" | "30" | "90" | "later";

export const HORIZON_LABELS: Record<Horizon, string> = {
  now: "Ready now",
  "30": "Within 30 days",
  "90": "31–90 days",
  later: "Later",
};

export interface RenewalForecastRow {
  advance: AdvanceRow;
  /** The day it crosses its renewal line (today when it already has). */
  renewalOn: ISODate;
  horizon: Horizon;
  pct: number;
  /** Same terms again: what renewing at the same amount would earn. */
  expected: CommissionAmount | null;
}

export interface RenewalForecast {
  rows: RenewalForecastRow[];
  /** Active advances left out of the forecast, and why. */
  excluded: Excluded;
  totalCents: number;
  unknown: number;
  byHorizon: Record<Horizon, { count: number; cents: number }>;
}

function horizonOf(renewalOn: ISODate, today: ISODate): Horizon {
  if (renewalOn <= today) return "now";
  if (renewalOn <= addDays(today, 30)) return "30";
  if (renewalOn <= addDays(today, 90)) return "90";
  return "later";
}

/**
 * Every active advance, renewed at the same terms the day it crosses its renewal line. Merchants who said no, are
 * do-not-contact, or are already in a funding deal (the Pipeline tile prices that) are left out and counted.
 */
export function renewalForecast(
  advances: readonly AdvanceRow[],
  today: ISODate,
  ctx: CommissionContext,
  thresholds: FunderThresholds = new Map(),
  override: number | null = null,
  cards: readonly Pick<ClientCard, "id" | "stage" | "contact_status">[] = [],
): RenewalForecast {
  const rows: RenewalForecastRow[] = [];
  const excluded = noExclusions();
  const cardOf = new Map(cards.map((c) => [c.id, c]));
  for (const advance of advances) {
    if (advance.status !== "active") continue;
    const p = advanceProgress(advance, renewalThreshold(advance, thresholds, override), today);
    if (p.crossesOn === null) continue;
    const card = cardOf.get(advance.clientId);
    const why = card ? notRenewable(card, { pipeline: true }) : null;
    if (why) {
      tally(excluded, why);
      continue;
    }
    // already crossed: the day to call is today
    const renewalOn = p.crossesOn < today ? today : p.crossesOn;
    rows.push({
      advance,
      renewalOn,
      horizon: horizonOf(renewalOn, today),
      pct: p.pct,
      expected: expectedCommission(advance, ctx),
    });
  }
  rows.sort(
    (a, b) =>
      a.renewalOn.localeCompare(b.renewalOn) ||
      (b.expected?.cents ?? -1) - (a.expected?.cents ?? -1),
  );
  const byHorizon: RenewalForecast["byHorizon"] = {
    now: { count: 0, cents: 0 },
    "30": { count: 0, cents: 0 },
    "90": { count: 0, cents: 0 },
    later: { count: 0, cents: 0 },
  };
  for (const r of rows) {
    byHorizon[r.horizon].count += 1;
    byHorizon[r.horizon].cents += r.expected?.cents ?? 0;
  }
  const sum = sumCommission(rows.map((r) => r.expected));
  return { rows, excluded, totalCents: sum.cents, unknown: sum.unknown, byHorizon };
}
