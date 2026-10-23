import { addDays, addMonths, isLongGame, type ISODate } from "../mca/dates";
import { balanceCents, paydownPct, renewalDate, type FundingTerms } from "../mca/funding";
import { stageDef, type StageGroup, type TimerKind } from "../mca/stages";
import { formatDate } from "../format";
import type { ClientCard } from "./types";

/** The latest advance as pure terms, or null when the card has none (or is missing a number). */
export function cardFundingTerms(c: ClientCard): FundingTerms | null {
  if (
    c.funded_on === null ||
    c.funding_amount_cents === null ||
    c.factor_rate === null ||
    c.funding_payment_cents === null ||
    c.funding_frequency === null
  ) {
    return null;
  }
  return {
    fundedOn: c.funded_on,
    amountCents: c.funding_amount_cents,
    factorRate: c.factor_rate,
    paymentCents: c.funding_payment_cents,
    frequency: c.funding_frequency,
    paidBackOverrideCents: c.paid_back_override_cents,
  };
}

const KIND_RANK: Record<TimerKind, number> = {
  scheduled_call: 0,
  renewal: 1,
  chase: 2,
  check_in: 3,
  follow_up: 4,
};
// Deals closest to funding first, then accounts that need chasing, then the rest.
const GROUP_RANK: Record<StageGroup, number> = {
  underwriting: 0,
  trouble: 1,
  funded: 2,
  prospecting: 3,
  exit: 4,
};

function byPriority(a: ClientCard, b: ClientCard): number {
  const ka = KIND_RANK[a.next_due_kind ?? "follow_up"];
  const kb = KIND_RANK[b.next_due_kind ?? "follow_up"];
  if (ka !== kb) return ka - kb;
  if (a.next_due_kind === "scheduled_call" && a.scheduled_call_at && b.scheduled_call_at) {
    return a.scheduled_call_at.localeCompare(b.scheduled_call_at);
  }
  const ga = GROUP_RANK[stageDef(a.stage).group];
  const gb = GROUP_RANK[stageDef(b.stage).group];
  return ga - gb || a.business_name.localeCompare(b.business_name);
}

export interface TodayView {
  /** Calls booked for today, earliest first. */
  scheduled: ClientCard[];
  /** Oldest first — the longer it waits, the more it costs. */
  overdue: ClientCard[];
  dueToday: ClientCard[];
  /** Tomorrow through 7 days out. */
  upcoming: ClientCard[];
  kpis: {
    overdue: number;
    dueToday: number;
    next7: number;
    renewalReady: number;
    fundedActive: number;
    outstandingCents: number;
  };
}

export function buildToday(cards: readonly ClientCard[], today: ISODate): TodayView {
  // A do-not-contact merchant is never on the call list, however their timer reads.
  const due = cards.filter(
    (c): c is ClientCard & { next_due_on: ISODate } =>
      c.next_due_on !== null && c.contact_status !== "dnc",
  );
  const scheduled = due
    .filter((c) => c.next_due_on === today && c.next_due_kind === "scheduled_call")
    .sort(byPriority);
  const overdue = due
    .filter((c) => c.next_due_on < today)
    .sort((a, b) => a.next_due_on.localeCompare(b.next_due_on) || byPriority(a, b));
  const dueToday = due
    .filter((c) => c.next_due_on === today && c.next_due_kind !== "scheduled_call")
    .sort(byPriority);
  const weekOut = addDays(today, 7);
  const upcoming = due
    .filter((c) => c.next_due_on > today && c.next_due_on <= weekOut)
    .sort((a, b) => a.next_due_on.localeCompare(b.next_due_on) || byPriority(a, b));

  let renewalReady = 0;
  let fundedActive = 0;
  let outstandingCents = 0;
  for (const c of cards) {
    const terms = cardFundingTerms(c);
    if (!terms || c.funding_status !== "active") continue;
    fundedActive += 1;
    outstandingCents += balanceCents(terms, today);
    if (paydownPct(terms, today) >= 50) renewalReady += 1;
  }
  return {
    scheduled,
    overdue,
    dueToday,
    upcoming,
    kpis: {
      overdue: overdue.length,
      dueToday: dueToday.length + scheduled.length,
      next7: upcoming.length,
      renewalReady,
      fundedActive,
      outstandingCents,
    },
  };
}

export interface RenewalRow {
  card: ClientCard;
  pct: number;
  balanceCents: number;
  /** The day the merchant crosses 50% (or today if they already have). */
  renewalOn: ISODate | null;
}

export interface RenewalsView {
  /** Active advances at or above the threshold, most paid down first. */
  ready: RenewalRow[];
  /** Paid in full — the hottest leads Isaac owns. */
  paidOff: ClientCard[];
}

export function buildRenewals(
  cards: readonly ClientCard[],
  today: ISODate,
  minPct: number,
): RenewalsView {
  const ready: RenewalRow[] = [];
  for (const card of cards) {
    const terms = cardFundingTerms(card);
    if (!terms || card.funding_status !== "active") continue;
    const pct = paydownPct(terms, today);
    if (pct < minPct) continue;
    ready.push({
      card,
      pct,
      balanceCents: balanceCents(terms, today),
      renewalOn: renewalDate(terms, today),
    });
  }
  ready.sort((a, b) => b.pct - a.pct || a.card.business_name.localeCompare(b.card.business_name));
  const paidOff = cards
    .filter((c) => c.stage === "paid_in_full")
    .sort(
      (a, b) =>
        (a.next_due_on ?? "").localeCompare(b.next_due_on ?? "") ||
        a.business_name.localeCompare(b.business_name),
    );
  return { ready, paidOff };
}

export interface LongGameGroup {
  key: string;
  label: string;
  cards: ClientCard[];
}

/** Everyone parked more than a year out, grouped by the month they come back. */
export function groupLongGame(cards: readonly ClientCard[], today: ISODate): LongGameGroup[] {
  const groups = new Map<string, ClientCard[]>();
  for (const c of cards) {
    if (c.next_due_on === null || !isLongGame(c.next_due_on, today)) continue;
    const key = c.next_due_on.slice(0, 7);
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({
      key,
      label: formatDate(`${key}-01`).split(" ")[0] + " " + key.slice(0, 4),
      cards: list.sort(
        (a, b) =>
          (a.next_due_on ?? "").localeCompare(b.next_due_on ?? "") ||
          a.business_name.localeCompare(b.business_name),
      ),
    }));
}

export function longGameCutoff(today: ISODate): ISODate {
  return addMonths(today, 12);
}
