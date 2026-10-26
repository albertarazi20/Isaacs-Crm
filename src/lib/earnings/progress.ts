import { diffDays, type ISODate } from "../mca/dates";
import {
  dateAtPaydown,
  paidToDateCents,
  paybackCents,
  payoffDate,
  RENEWAL_PAYDOWN_PCT,
} from "../mca/funding";
import { funderKey } from "./commission";
import { advanceTerms, type AdvanceRow, type FunderTerms } from "./types";

/** Funder name (lower-cased) → how far paid down that funder wants a merchant before it will renew. */
export type FunderThresholds = ReadonlyMap<string, number>;

export function funderThresholdMap(funders: readonly FunderTerms[]): FunderThresholds {
  const m = new Map<string, number>();
  for (const f of funders)
    if (f.renewalPaydownPct !== null) m.set(funderKey(f.name), f.renewalPaydownPct);
  return m;
}

/**
 * The paid-down percentage at which this advance can renew: the page's explicit ?min=, else the funder's own
 * figure from the Funders page, else the shop default (50).
 */
export function renewalThreshold(
  a: Pick<AdvanceRow, "funderName">,
  funders: FunderThresholds,
  override: number | null,
): number {
  return override ?? funders.get(funderKey(a.funderName)) ?? RENEWAL_PAYDOWN_PCT;
}

export interface Progress {
  paybackCents: number;
  paidCents: number;
  balanceCents: number;
  /** 0–100, one decimal. */
  pct: number;
  thresholdPct: number;
  /** Paid down at least the threshold, judged on cents (never on a rounded percentage). */
  eligible: boolean;
  /**
   * The day the threshold is (or was) crossed: today or earlier when eligible — never later than today, because
   * a collected figure he typed can put a merchant ahead of the remittance schedule — and the scheduled day when not.
   */
  crossesOn: ISODate | null;
  /** The schedule's last remittance day. */
  payoffOn: ISODate | null;
  /** Collected in full: by the schedule or by the figure he typed. */
  paidInFull: boolean;
}

export function advanceProgress(a: AdvanceRow, thresholdPct: number, today: ISODate): Progress {
  const terms = advanceTerms(a);
  const payback = paybackCents(terms.amountCents, terms.factorRate);
  const paid = paidToDateCents(terms, today);
  const eligible = payback > 0 && paid * 100 >= thresholdPct * payback;
  const scheduled = dateAtPaydown(terms, thresholdPct);
  return {
    paybackCents: payback,
    paidCents: paid,
    balanceCents: payback - paid,
    pct: payback > 0 ? Math.round((paid / payback) * 1000) / 10 : 0,
    thresholdPct,
    eligible,
    crossesOn: eligible ? (scheduled !== null && scheduled < today ? scheduled : today) : scheduled,
    payoffOn: payoffDate(terms),
    paidInFull: payback > 0 && paid >= payback,
  };
}

/** Whole days between two calendar days, never negative. */
export const daysBetween = (from: ISODate, to: ISODate): number => Math.max(0, diffDays(from, to));
