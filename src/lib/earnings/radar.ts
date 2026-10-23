import type { ClientCard } from "../data/types";
import { diffDays, todayIn, type ISODate } from "../mca/dates";
import {
  expectedCommission,
  sumCommission,
  type CommissionAmount,
  type CommissionContext,
} from "./commission";
import {
  advanceProgress,
  daysBetween,
  renewalThreshold,
  type FunderThresholds,
  type Progress,
} from "./progress";
import { noExclusions, notRenewable, tally, type Excluded } from "./eligible";
import type { AdvanceRow } from "./types";

/** A merchant who paid off in the last 30 days is the hottest lead the shop owns. */
export const HOT_DAYS = 30;

export interface Contact {
  /** The calendar day of the last call, text or email; null when there has never been one. */
  lastContactOn: ISODate | null;
  daysSinceContact: number | null;
}

/** Last call/text/email from the card, as a calendar day in Isaac's time zone. */
export function contactOf(
  card: Pick<ClientCard, "last_touch_at">,
  today: ISODate,
  timezone: string,
): Contact {
  if (!card.last_touch_at) return { lastContactOn: null, daysSinceContact: null };
  const on = todayIn(timezone, new Date(card.last_touch_at));
  return { lastContactOn: on, daysSinceContact: daysBetween(on, today) };
}

export interface RadarRow extends Contact {
  card: ClientCard;
  advance: AdvanceRow;
  progress: Progress;
  /** Days since the merchant crossed the renewal line (0 = today). */
  eligibleDays: number;
  expected: CommissionAmount | null;
  /** No call, text or email since the day they became eligible. */
  notContactedSinceEligible: boolean;
  /** eligible days × expected commission: how much money is going stale, which is how the list is ordered. */
  score: number;
}

export interface PaidRow extends Contact {
  card: ClientCard;
  /** The advance that was paid off, when the merchant has one on record. */
  advance: AdvanceRow | null;
  /** Days since the card moved to Paid in full. */
  daysSincePaidOff: number;
  hot: boolean;
  /** Renewing at the same terms. */
  expected: CommissionAmount | null;
}

export interface PastPayoffRow {
  card: ClientCard;
  advance: AdvanceRow;
  progress: Progress;
  /** The schedule's last remittance day, when that is what put it past payoff. */
  payoffOn: ISODate | null;
  /** Days since that day (0 = today); null when only a collected figure he typed says it is paid. */
  daysPast: number | null;
}

export interface Radar {
  ready: RadarRow[];
  paidInFull: PaidRow[];
  pastPayoff: PastPayoffRow[];
  /** Merchants with an active advance left off the list, and why. */
  excluded: Excluded;
  totals: {
    outstandingCents: number;
    expectedCents: number;
    expectedUnknown: number;
    neverContacted: number;
  };
}

export interface RadarInput {
  cards: readonly ClientCard[];
  advances: readonly AdvanceRow[];
  today: ISODate;
  timezone: string;
  /** ?min= from the page: one threshold for everyone. Null = each funder's own, else 50. */
  minPct: number | null;
  thresholds: FunderThresholds;
  commission: CommissionContext;
}

const PAYOFF_STAGES = new Set(["funded", "paying_off_soon"]);

export function buildRadar(input: RadarInput): Radar {
  const { cards, advances, today, timezone, minPct, thresholds, commission } = input;
  const byClient = new Map<string, AdvanceRow[]>();
  for (const a of advances) byClient.set(a.clientId, [...(byClient.get(a.clientId) ?? []), a]);

  const ready: RadarRow[] = [];
  const pastPayoff: PastPayoffRow[] = [];
  const paidInFull: PaidRow[] = [];
  const excluded = noExclusions();

  for (const card of cards) {
    const mine = byClient.get(card.id) ?? [];
    const active = mine.find((a) => a.status === "active");
    if (active) {
      const p = advanceProgress(active, renewalThreshold(active, thresholds, minPct), today);
      // Said no / went elsewhere / do-not-contact: not a call he can make, so not on the list and not in the dollars.
      // (A merchant already working a renewal deal stays: that is the renewal in progress.)
      const why = p.eligible ? notRenewable(card, { pipeline: false }) : null;
      if (why) tally(excluded, why);
      else if (p.eligible) {
        const contact = contactOf(card, today, timezone);
        const eligibleOn = p.crossesOn ?? today;
        const eligibleDays = daysBetween(eligibleOn, today);
        const expected = expectedCommission(active, commission);
        ready.push({
          card,
          advance: active,
          progress: p,
          eligibleDays,
          expected,
          ...contact,
          notContactedSinceEligible:
            contact.lastContactOn === null || contact.lastContactOn < eligibleOn,
          score: eligibleDays * (expected?.cents ?? 0),
        });
      }
      // Past the estimated payoff and still sitting in Funded: offer to move it. (The card's own stage decides — a
      // merchant already in default or paid in full has nothing to prompt.)
      const full = advanceProgress(active, 100, today);
      if (full.paidInFull && PAYOFF_STAGES.has(card.stage)) {
        const payoffOn = full.payoffOn !== null && full.payoffOn <= today ? full.payoffOn : null;
        pastPayoff.push({
          card,
          advance: active,
          progress: full,
          payoffOn,
          daysPast: payoffOn === null ? null : diffDays(payoffOn, today),
        });
      }
    }
    if (card.stage === "paid_in_full") {
      const last = [...mine].sort((a, b) => b.fundedOn.localeCompare(a.fundedOn))[0] ?? null;
      const days = daysBetween(todayIn(timezone, new Date(card.stage_changed_at)), today);
      paidInFull.push({
        card,
        advance: last,
        daysSincePaidOff: days,
        hot: days <= HOT_DAYS,
        expected: last ? expectedCommission(last, commission) : null,
        ...contactOf(card, today, timezone),
      });
    }
  }

  ready.sort(
    (a, b) =>
      b.score - a.score ||
      b.eligibleDays - a.eligibleDays ||
      (b.expected?.cents ?? -1) - (a.expected?.cents ?? -1) ||
      b.progress.pct - a.progress.pct ||
      a.card.business_name.localeCompare(b.card.business_name),
  );
  paidInFull.sort(
    (a, b) =>
      a.daysSincePaidOff - b.daysSincePaidOff ||
      a.card.business_name.localeCompare(b.card.business_name),
  );
  pastPayoff.sort(
    (a, b) =>
      (b.daysPast ?? -1) - (a.daysPast ?? -1) ||
      a.card.business_name.localeCompare(b.card.business_name),
  );

  const sum = sumCommission(ready.map((r) => r.expected));
  return {
    ready,
    paidInFull,
    pastPayoff,
    excluded,
    totals: {
      outstandingCents: ready.reduce((s, r) => s + r.progress.balanceCents, 0),
      expectedCents: sum.cents,
      expectedUnknown: sum.unknown,
      neverContacted: ready.filter((r) => r.notContactedSinceEligible).length,
    },
  };
}
