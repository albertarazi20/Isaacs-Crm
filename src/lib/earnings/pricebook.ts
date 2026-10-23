import { funderKey } from "./commission";
import type { AdvanceRow, CompetingOfferRow, OfferRow } from "./types";

/**
 * Below this many DIFFERENT MERCHANTS an average is shown as a count only — three is the least that is not an
 * anecdote, and one merchant's accepted offer, the advance funded from it and the other funder's lower offer are
 * one deal, not three.
 */
export const MIN_SAMPLE = 3;

export type PriceSource = "funded" | "offer" | "competitor";

export const SOURCE_LABELS: Record<PriceSource, string> = {
  funded: "Advances I funded",
  offer: "Offers from my funders",
  competitor: "Competing offers",
};

/** One price he has seen: a factor rate, with the details it can be sliced by. */
export interface PriceObservation {
  source: PriceSource;
  /** Whose deal it was; the sample size counts these, not prices. */
  clientId: string;
  factor: number;
  positionNo: number | null;
  industry: string;
  funder: string;
  amountCents: number | null;
}

export interface PriceBookInput {
  advances: readonly AdvanceRow[];
  /** Offers from his own funders; empty when the Funders feature is not installed. */
  offers: readonly (OfferRow & { industry: string })[];
  competing: readonly CompetingOfferRow[];
}

export function observations(input: PriceBookInput): PriceObservation[] {
  const out: PriceObservation[] = [];
  // An offer he took and then funded is the same price as that advance: counted once, as the advance.
  const funded = new Set(
    input.advances.map((a) => `${a.clientId}|${a.amountCents}|${Math.round(a.factorRate * 1000)}`),
  );
  for (const a of input.advances) {
    out.push({
      source: "funded",
      clientId: a.clientId,
      factor: a.factorRate,
      positionNo: a.positionNo,
      industry: a.industry,
      funder: a.funderName,
      amountCents: a.amountCents,
    });
  }
  for (const o of input.offers) {
    if (funded.has(`${o.clientId}|${o.amountCents}|${Math.round(o.factorRate * 1000)}`)) continue;
    out.push({
      source: "offer",
      clientId: o.clientId,
      factor: o.factorRate,
      positionNo: o.positionNo,
      industry: o.industry,
      funder: o.funderName,
      amountCents: o.amountCents,
    });
  }
  for (const c of input.competing) {
    if (c.factorRate === null) continue;
    out.push({
      source: "competitor",
      clientId: c.clientId,
      factor: c.factorRate,
      positionNo: c.positionNo,
      industry: c.industry,
      funder: c.funderName,
      amountCents: c.amountCents,
    });
  }
  return out;
}

export interface PriceGroup {
  key: string;
  label: string;
  /** How many prices the average is built from. */
  n: number;
  /** How many different merchants those prices come from. */
  merchants: number;
  /** Mean factor rate, three decimals. Null while fewer than MIN_SAMPLE merchants: no conclusion from one or two. */
  average: number | null;
  low: number;
  high: number;
}

/** Mean of factor rates without float drift: sum in thousandths. */
export function meanFactor(factors: readonly number[]): number | null {
  if (factors.length === 0) return null;
  const sum = factors.reduce((s, f) => s + Math.round(f * 1000), 0);
  return Math.round(sum / factors.length) / 1000;
}

type Slice = { key: string; label: string } | null;

export function groupFactors(
  obs: readonly PriceObservation[],
  slice: (o: PriceObservation) => Slice,
): PriceGroup[] {
  const buckets = new Map<string, { label: string; factors: number[]; merchants: Set<string> }>();
  for (const o of obs) {
    const s = slice(o);
    if (!s) continue;
    const b = buckets.get(s.key) ?? { label: s.label, factors: [], merchants: new Set<string>() };
    b.factors.push(o.factor);
    b.merchants.add(o.clientId);
    buckets.set(s.key, b);
  }
  return [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      label: b.label,
      n: b.factors.length,
      merchants: b.merchants.size,
      average: b.merchants.size >= MIN_SAMPLE ? meanFactor(b.factors) : null,
      low: Math.min(...b.factors),
      high: Math.max(...b.factors),
    }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

const ORDINAL = ["1st", "2nd", "3rd"];

/** 1st / 2nd / 3rd / 4th+ — position four and beyond share a row, there are too few to split. */
export const positionSlice = (o: PriceObservation): Slice => {
  if (o.positionNo === null) return null;
  const p = Math.min(4, Math.max(1, o.positionNo));
  return { key: String(p), label: ORDINAL[p - 1] ?? "4th+" };
};

const clean = (s: string) => s.trim().replace(/\s+/g, " ");

export const industrySlice = (o: PriceObservation): Slice => {
  const name = clean(o.industry);
  return name ? { key: name.toLowerCase(), label: name } : null;
};

export const funderSlice = (o: PriceObservation): Slice => {
  const name = clean(o.funder);
  return name ? { key: funderKey(name), label: name } : null;
};

export const positionOrder = (g: PriceGroup[]): PriceGroup[] =>
  [...g].sort((a, b) => Number(a.key) - Number(b.key));

export function fromSource(
  obs: readonly PriceObservation[],
  sources: ReadonlySet<PriceSource>,
): PriceObservation[] {
  return obs.filter((o) => sources.has(o.source));
}

// ---------------------------------------------------------------------------------------------
// win / loss: how far off was the price of the deals he lost?

export interface LostDeal {
  clientId: string;
  businessName: string;
  /** The competitor who won the merchant, and the factor they offered. */
  competitorFunder: string;
  competitorFactor: number;
  /** His own best (lowest) offer on the deal; null when none was logged. */
  ourBestFactor: number | null;
  ourBestFunder: string | null;
}

export interface LostDealGap extends LostDeal {
  /** Competitor − ours, in factor points: positive = they were MORE expensive than his best offer. */
  gap: number | null;
}

export interface LossGap {
  deals: LostDealGap[];
  /** Lost deals that have both a competing offer and one of his own to compare. */
  compared: number;
  withoutOurOffer: number;
  /** Mean gap over the compared deals; null while fewer than MIN_SAMPLE. */
  averageGap: number | null;
  cheaper: number;
  pricier: number;
  same: number;
}

/**
 * Joins his lost deals to his own best offer on each. Competing offers where `won` is true are the deals he lost;
 * with several on one merchant the lowest-priced one is the one to beat.
 */
export function lostDeals(
  competing: readonly CompetingOfferRow[],
  offers: readonly OfferRow[],
): LostDeal[] {
  const wins = new Map<string, CompetingOfferRow>();
  for (const c of competing) {
    if (!c.won || c.factorRate === null) continue;
    const cur = wins.get(c.clientId);
    if (!cur || (cur.factorRate ?? Infinity) > c.factorRate) wins.set(c.clientId, c);
  }
  const best = new Map<string, OfferRow>();
  for (const o of offers) {
    const cur = best.get(o.clientId);
    if (!cur || cur.factorRate > o.factorRate) best.set(o.clientId, o);
  }
  return [...wins.values()]
    .map((c) => {
      const mine = best.get(c.clientId) ?? null;
      return {
        clientId: c.clientId,
        businessName: c.businessName,
        competitorFunder: c.funderName,
        competitorFactor: c.factorRate ?? 0,
        ourBestFactor: mine?.factorRate ?? null,
        ourBestFunder: mine?.funderName ?? null,
      };
    })
    .sort((a, b) => a.businessName.localeCompare(b.businessName));
}

export function lossGap(deals: readonly LostDeal[]): LossGap {
  const rows: LostDealGap[] = deals.map((d) => ({
    ...d,
    gap:
      d.ourBestFactor === null
        ? null
        : Math.round((d.competitorFactor - d.ourBestFactor) * 1000) / 1000,
  }));
  const compared = rows.filter((r) => r.gap !== null);
  const gaps = compared.map((r) => r.gap ?? 0);
  return {
    deals: rows,
    compared: compared.length,
    withoutOurOffer: rows.length - compared.length,
    averageGap:
      gaps.length >= MIN_SAMPLE
        ? Math.round((gaps.reduce((s, g) => s + g, 0) / gaps.length) * 1000) / 1000
        : null,
    cheaper: gaps.filter((g) => g < 0).length,
    pricier: gaps.filter((g) => g > 0).length,
    same: gaps.filter((g) => g === 0).length,
  };
}
