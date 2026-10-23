import type { ClientCard } from "../data/types";
import { addDays, todayIn, type ISODate } from "../mca/dates";
import type { StageKey } from "../mca/stages";
import { factorText, winbackText, type WinbackOffer } from "../mca/templates";
import { formatMoneyCompact } from "../money";

/**
 * Win-back: merchants who said no, went silent, were declined or funded elsewhere, whose follow-up date is
 * coming up. "A dead lead from 2024 is a warm call today." Pure — the page feeds it cards and offers.
 */

export const WINBACK_STAGES: readonly StageKey[] = [
  "dead",
  "declined",
  "lost",
  "killed",
  "not_interested",
  "written_off",
];

export const WINBACK_DEFAULT_DAYS = 30;
export const WINBACK_MAX_DAYS = 365;
export const WINBACK_BATCH = 10;
export const WINBACK_DAY_CHOICES: readonly number[] = [7, 14, 30, 60, 90];

/** `?days=` from the address bar: a whole number from 1 to 365, otherwise 30. */
export function parseWinbackDays(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) return WINBACK_DEFAULT_DAYS;
  return Math.min(n, WINBACK_MAX_DAYS);
}

/** One row of competing_offers, as the page reads it. */
export interface OfferRecord {
  client_id: string;
  funder_name: string;
  amount_cents: number | null;
  factor_rate: number | null;
  term_days: number | null;
  offered_on: ISODate;
  won: boolean;
}

export interface WinbackRow {
  card: ClientCard;
  /** The competitor's offer for a lost deal: the one they took, else the biggest. */
  offer: OfferRecord | null;
  /** What this merchant is worth chasing for: the last ask, or for a lost deal the competitor's offer. */
  moneyCents: number;
  /** A text or call was already logged today, so the batch moves on. */
  doneToday: boolean;
}

function pickOffer(offers: readonly OfferRecord[]): OfferRecord | null {
  let best: OfferRecord | null = null;
  const rank = (o: OfferRecord) => [o.won ? 1 : 0, o.amount_cents ?? -1, o.offered_on] as const;
  for (const o of offers) {
    if (best === null) {
      best = o;
      continue;
    }
    const a = rank(o);
    const b = rank(best);
    if (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]) best = o;
  }
  return best;
}

/**
 * Everyone in a win-back stage due within `days` (overdue included), never anyone who asked to be left alone
 * (`contact_status` other than "ok" means skip them entirely, even for a channel they didn't refuse), biggest
 * money first and, for equal money, the most recently lost.
 */
export function buildWinback(
  cards: readonly ClientCard[],
  offers: readonly OfferRecord[],
  opts: { today: ISODate; days: number; timezone: string },
): WinbackRow[] {
  const horizon = addDays(opts.today, opts.days);
  const byClient = new Map<string, OfferRecord[]>();
  for (const o of offers) byClient.set(o.client_id, [...(byClient.get(o.client_id) ?? []), o]);

  const rows: WinbackRow[] = [];
  for (const card of cards) {
    if (!WINBACK_STAGES.includes(card.stage)) continue;
    if (card.contact_status !== "ok") continue;
    if (card.next_due_on === null || card.next_due_on > horizon) continue;
    const offer = card.stage === "lost" ? pickOffer(byClient.get(card.id) ?? []) : null;
    const money = Math.max(card.wanted_amount_cents ?? 0, offer?.amount_cents ?? 0);
    rows.push({
      card,
      offer,
      moneyCents: money,
      doneToday:
        card.last_touch_at !== null &&
        todayIn(opts.timezone, new Date(card.last_touch_at)) === opts.today,
    });
  }
  return rows.sort(
    (a, b) =>
      b.moneyCents - a.moneyCents ||
      b.card.stage_changed_at.localeCompare(a.card.stage_changed_at) ||
      a.card.business_name.localeCompare(b.card.business_name),
  );
}

/** The ten to work now, the rest waiting, and the ones already texted today. */
export function splitBatch(rows: readonly WinbackRow[], size: number = WINBACK_BATCH) {
  const open = rows.filter((r) => !r.doneToday);
  return {
    batch: open.slice(0, size),
    later: open.slice(size),
    done: rows.filter((r) => r.doneToday),
  };
}

export function toWinbackOffer(o: OfferRecord | null): WinbackOffer | null {
  return o
    ? {
        funderName: o.funder_name,
        factorRate: o.factor_rate,
        termDays: o.term_days,
        offeredOn: o.offered_on,
        won: o.won,
      }
    : null;
}

/** The suggested first text for one row. */
export function winbackSuggestion(row: WinbackRow, senderName: string, today: ISODate): string {
  return winbackText({
    contactName: row.card.contact_name,
    businessName: row.card.business_name,
    stage: row.card.stage,
    senderName,
    wantedAmountCents: row.card.wanted_amount_cents,
    offer: toWinbackOffer(row.offer),
    today,
  });
}

/** A one-line version of a row, for the long tail below the batch. */
export interface CompactRow {
  id: string;
  businessName: string;
  stage: StageKey;
  dueOn: ISODate | null;
  moneyCents: number;
}

export function compact(row: WinbackRow): CompactRow {
  return {
    id: row.card.id,
    businessName: row.card.business_name,
    stage: row.card.stage,
    dueOn: row.card.next_due_on,
    moneyCents: row.moneyCents,
  };
}

/** What this merchant is worth, in words: "Rival Capital offered $50k at 1.42" or "Asked for $60k". */
export function moneyLine(row: WinbackRow): string | null {
  const o = row.offer;
  if (o) {
    const bits = [
      o.amount_cents ? formatMoneyCompact(o.amount_cents) : "",
      o.factor_rate ? `at ${factorText(o.factor_rate)}` : "",
    ].filter(Boolean);
    return `${o.funder_name}${o.won ? " funded" : " offered"}${bits.length ? ` ${bits.join(" ")}` : ""}`;
  }
  return row.card.wanted_amount_cents
    ? `Asked for ${formatMoneyCompact(row.card.wanted_amount_cents)}`
    : null;
}
