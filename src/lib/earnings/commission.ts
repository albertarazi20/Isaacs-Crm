import { formatMoney } from "../money";
import type { AdvanceRow } from "./types";

/** Points of the advance the shop keeps: $2,500 on $50,000 is 5 points. */
export function pointsOf(commissionCents: number, amountCents: number): number | null {
  return amountCents > 0 ? (commissionCents / amountCents) * 100 : null;
}

export function centsFromPoints(points: number, amountCents: number): number {
  return Math.round((amountCents * points) / 100);
}

/** 5 → "5", 5.25 → "5.25", 4.999 → "5": never more than two decimals. */
export function formatPoints(points: number): string {
  return String(Math.round(points * 100) / 100);
}

export interface AveragePoints {
  /** Mean points across the advances that have a commission on record, e.g. 5.2. */
  points: number;
  /** How many advances it is based on. */
  n: number;
}

/**
 * His own average points, from history: for every advance with a commission above zero (the amount he
 * entered, or failing that what he received), commission ÷ advance × 100, then the plain mean.
 * Null when there is no such advance — the page then says so instead of inventing a number.
 */
export function averagePoints(
  advances: readonly Pick<
    AdvanceRow,
    "amountCents" | "commissionCents" | "commissionReceivedCents"
  >[],
): AveragePoints | null {
  const each: number[] = [];
  for (const a of advances) {
    const known = a.commissionCents ?? a.commissionReceivedCents;
    if (known === null || known <= 0) continue;
    const p = pointsOf(known, a.amountCents);
    if (p !== null) each.push(p);
  }
  if (each.length === 0) return null;
  return { points: each.reduce((s, p) => s + p, 0) / each.length, n: each.length };
}

export const funderKey = (name: string): string => name.trim().toLowerCase();

/** Funder name (lower-cased) → the commission points he has on that funder's page. */
export type FunderPoints = ReadonlyMap<string, number>;

export interface CommissionContext {
  average: AveragePoints | null;
  funderPoints?: FunderPoints;
}

/**
 * Where a commission figure came from, so the page can say how sure it is:
 * entered = a number he typed or received; funder = that funder's points × the advance; estimate = his average points.
 */
export type CommissionBasis = "entered" | "funder" | "estimate";

export interface CommissionAmount {
  cents: number;
  basis: CommissionBasis;
  /** The points the figure used, when it was worked out from points. */
  points?: number;
}

/** Commission on an amount that has no figure of its own yet: the funder's points, else his average. */
export function estimateCommission(
  amountCents: number,
  funderName: string,
  ctx: CommissionContext,
): CommissionAmount | null {
  if (amountCents <= 0) return null;
  const own = ctx.funderPoints?.get(funderKey(funderName));
  if (own !== undefined) {
    return { cents: centsFromPoints(own, amountCents), basis: "funder", points: own };
  }
  if (ctx.average) {
    return {
      cents: centsFromPoints(ctx.average.points, amountCents),
      basis: "estimate",
      points: ctx.average.points,
    };
  }
  return null;
}

/**
 * What an advance earns: the commission he entered; else what he received; else the funder's points × the
 * amount; else his average points × the amount (an estimate); else unknown (null).
 */
export function expectedCommission(
  a: Pick<AdvanceRow, "amountCents" | "commissionCents" | "commissionReceivedCents" | "funderName">,
  ctx: CommissionContext,
): CommissionAmount | null {
  if (a.commissionCents !== null) return { cents: a.commissionCents, basis: "entered" };
  if (a.commissionReceivedCents !== null)
    return { cents: a.commissionReceivedCents, basis: "entered" };
  return estimateCommission(a.amountCents, a.funderName, ctx);
}

/** Sum of the known figures, and how many were unknown (never counted as zero). */
export function sumCommission(items: readonly (CommissionAmount | null)[]): {
  cents: number;
  known: number;
  unknown: number;
  estimated: number;
} {
  let cents = 0;
  let known = 0;
  let estimated = 0;
  for (const i of items) {
    if (!i) continue;
    cents += i.cents;
    known += 1;
    if (i.basis !== "entered") estimated += 1;
  }
  return { cents, known, unknown: items.length - known, estimated };
}

/** One sentence on where a commission figure came from — the tooltip text next to every estimate. */
export function commissionNote(
  c: CommissionAmount,
  average: AveragePoints | null,
  amountCents?: number,
): string {
  const of = amountCents === undefined ? "the advance amount" : formatMoney(amountCents);
  if (c.basis === "entered") return "The commission entered on the advance.";
  const pts = c.points === undefined ? "" : formatPoints(c.points);
  if (c.basis === "funder") return `Estimate: this funder's ${pts} points × ${of}.`;
  const from = average
    ? ` (the average of ${average.n} advance${average.n === 1 ? "" : "s"} with a commission on record)`
    : "";
  return `Estimate: your average ${pts} points${from} × ${of}.`;
}
