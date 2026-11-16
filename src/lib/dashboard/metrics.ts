/**
 * Dashboard maths, kept pure so it is testable without a database: goal pace, funnel conversion, the email meter
 * and the ranking behind the "do this now" list.
 */
import type { ISODate } from "../mca/dates";

// ---------- goal pace ----------

export type PaceStatus = "no_goal" | "done" | "ahead" | "on_track" | "behind";

export interface Pace {
  goalCents: number;
  fundedCents: number;
  /** 0–100, capped at 100. */
  pct: number;
  weekdaysTotal: number;
  weekdaysGone: number;
  weekdaysLeft: number;
  /** Where a straight line to the goal says you should be today. */
  expectedByNowCents: number;
  /** funded − expected. Negative means behind. */
  deltaCents: number;
  /** What has to fund on each remaining weekday to still hit the goal. */
  neededPerDayCents: number;
  status: PaceStatus;
}

/** Weekdays (Mon–Fri) in the month of `day`, and how many are gone counting `day` itself. */
export function weekdaysInMonth(day: ISODate): { total: number; gone: number } {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let total = 0;
  let gone = 0;
  for (let i = 1; i <= days; i++) {
    const dow = new Date(Date.UTC(y, m - 1, i)).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    total++;
    if (i <= d) gone++;
  }
  return { total, gone };
}

export function pace(fundedCents: number, goalCents: number, today: ISODate): Pace {
  const { total, gone } = weekdaysInMonth(today);
  const left = Math.max(0, total - gone);
  if (goalCents <= 0) {
    return {
      goalCents: 0,
      fundedCents,
      pct: 0,
      weekdaysTotal: total,
      weekdaysGone: gone,
      weekdaysLeft: left,
      expectedByNowCents: 0,
      deltaCents: 0,
      neededPerDayCents: 0,
      status: "no_goal",
    };
  }
  const expected = Math.round((goalCents * gone) / Math.max(1, total));
  const delta = fundedCents - expected;
  const remaining = Math.max(0, goalCents - fundedCents);
  const needed = left > 0 ? Math.ceil(remaining / left) : remaining;
  const pct = Math.min(100, Math.round((100 * fundedCents) / goalCents));
  // "On track" has a tolerance of one average day either way, so Monday morning is not "behind".
  const oneDay = goalCents / Math.max(1, total);
  const status: PaceStatus =
    fundedCents >= goalCents
      ? "done"
      : delta > oneDay
        ? "ahead"
        : delta < -oneDay
          ? "behind"
          : "on_track";
  return {
    goalCents,
    fundedCents,
    pct,
    weekdaysTotal: total,
    weekdaysGone: gone,
    weekdaysLeft: left,
    expectedByNowCents: expected,
    deltaCents: delta,
    neededPerDayCents: needed,
    status,
  };
}

// ---------- funnel ----------

export const FUNNEL = [
  { key: "leads", label: "Leads in" },
  { key: "apps_in", label: "Applications in" },
  { key: "submitted", label: "Submitted" },
  { key: "approved", label: "Approved" },
  { key: "funded", label: "Funded" },
] as const;
export type FunnelKey = (typeof FUNNEL)[number]["key"];
export type FunnelCounts = Record<FunnelKey, number>;

export interface FunnelStep {
  key: FunnelKey;
  label: string;
  count: number;
  /** Share of the previous step, 0–100. Null for the first step or when the previous step is empty. */
  fromPrevPct: number | null;
  /** Share of the first step, 0–100. */
  fromTopPct: number | null;
}

export function funnel(counts: FunnelCounts): FunnelStep[] {
  const top = counts.leads;
  return FUNNEL.map((s, i) => {
    const prev = i === 0 ? null : counts[FUNNEL[i - 1]!.key];
    const count = counts[s.key];
    return {
      key: s.key,
      label: s.label,
      count,
      fromPrevPct: prev === null || prev === 0 ? null : Math.round((100 * count) / prev),
      fromTopPct: top === 0 ? null : Math.round((100 * count) / top),
    };
  });
}

/** The step where the most deals die, as (step index, lost count). Null when there is nothing to compare. */
export function biggestLeak(
  steps: readonly FunnelStep[],
): { from: FunnelStep; to: FunnelStep; lost: number } | null {
  let best: { from: FunnelStep; to: FunnelStep; lost: number } | null = null;
  for (let i = 1; i < steps.length; i++) {
    const lost = steps[i - 1]!.count - steps[i]!.count;
    if (lost > 0 && (best === null || lost > best.lost))
      best = { from: steps[i - 1]!, to: steps[i]!, lost };
  }
  return best;
}

// ---------- email meter ----------

export type MeterTone = "green" | "amber" | "red";

export function meterTone(sent24h: number, cap: number, amberAt: number): MeterTone {
  if (sent24h >= cap) return "red";
  if (sent24h >= amberAt) return "amber";
  return "green";
}

// ---------- the "do this now" list ----------

export type NowKind =
  | "merchant_replied" // a merchant wrote back and nobody has answered
  | "decision" // an AI-proposed update is waiting for a manager
  | "kicked_back" // ops sent the file back to the rep
  | "offer_unpresented" // an offer is in and the merchant has not heard it
  | "approval_aging" // approved, not funded, getting cold
  | "renewal_ready" // paid down enough to renew
  | "stale_submission" // sent to a lender, no answer in days
  | "overdue"; // a follow-up timer is past due

/** Why one kind outranks another, before money and age are applied. */
export const NOW_WEIGHT: Record<NowKind, number> = {
  merchant_replied: 100,
  decision: 95,
  kicked_back: 90,
  offer_unpresented: 85,
  approval_aging: 80,
  renewal_ready: 70,
  overdue: 60,
  stale_submission: 50,
};

export interface NowItem {
  kind: NowKind;
  client_id: string;
  deal_id: string | null;
  business_name: string;
  /** One line: what to do. */
  label: string;
  /** One line: why now. */
  detail: string;
  cents: number;
  age_days: number;
  href: string;
  score: number;
}

/**
 * score = kind × 1000 + bonus, where bonus < 1000 comes from money (100 × ln(1 + dollars/1,000)) and age
 * (20 per day, two weeks at most). So the kind always decides the order between kinds — a reply outranks a stale
 * submission whatever the dollars — and money and age order the items inside one kind.
 */
export function nowScore(kind: NowKind, cents: number, ageDays: number): number {
  const money = 100 * Math.log1p(Math.max(0, cents) / 100_000);
  const age = 20 * Math.min(Math.max(0, ageDays), 14);
  return NOW_WEIGHT[kind] * 1000 + Math.min(999, Math.round(money + age));
}

export function rankNow(items: readonly Omit<NowItem, "score">[]): NowItem[] {
  return items
    .map((i) => ({ ...i, score: nowScore(i.kind, i.cents, i.age_days) }))
    .sort((a, b) => b.score - a.score || a.business_name.localeCompare(b.business_name));
}
