/**
 * Dashboard maths, kept pure so it is testable without a database: the email meter and the ranking behind the
 * "do this now" list.
 */

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
  | "overdue"; // a follow-up timer is past due

/** Why one kind outranks another, before the merchant's ask and age are applied. */
export const NOW_WEIGHT: Record<NowKind, number> = {
  merchant_replied: 100,
  overdue: 60,
};

export interface NowItem {
  kind: NowKind;
  client_id: string;
  business_name: string;
  /** One line: what to do. */
  label: string;
  /** One line: why now. */
  detail: string;
  /** What the merchant asked for, in cents (0 when unknown). */
  cents: number;
  age_days: number;
  href: string;
  score: number;
}

/**
 * score = kind × 1000 + bonus, where bonus < 1000 comes from the ask (100 × ln(1 + dollars/1,000)) and age
 * (20 per day, two weeks at most). So the kind always decides the order between kinds — a reply outranks an overdue
 * follow-up whatever the ask — and the ask and age order the items inside one kind.
 */
export function nowScore(kind: NowKind, cents: number, ageDays: number): number {
  const ask = 100 * Math.log1p(Math.max(0, cents) / 100_000);
  const age = 20 * Math.min(Math.max(0, ageDays), 14);
  return NOW_WEIGHT[kind] * 1000 + Math.min(999, Math.round(ask + age));
}

export function rankNow(items: readonly Omit<NowItem, "score">[]): NowItem[] {
  return items
    .map((i) => ({ ...i, score: nowScore(i.kind, i.cents, i.age_days) }))
    .sort((a, b) => b.score - a.score || a.business_name.localeCompare(b.business_name));
}
