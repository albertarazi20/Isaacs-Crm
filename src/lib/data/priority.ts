import { addBusinessDays, diffDays, parseISODate, todayIn, type ISODate } from "../mca/dates";
import { balanceCents, paydownPct, RENEWAL_PAYDOWN_PCT } from "../mca/funding";
import { stageDef, type StageKey } from "../mca/stages";
import { formatMoneyCompact } from "../money";
import type { ClientCard } from "./types";
import { cardFundingTerms } from "./views";

/**
 * "Who should I call first?" — pure ranking, no I/O.
 *
 *   score = dollars at stake  x  how close the stage is to money  x  how long it has been overdue
 *
 * A starred ("hot") client always goes first. Nothing here reads the database or the clock: callers
 * pass `today` (and the user's time zone, to read a promise-to-pay timestamp as a calendar day).
 */

/** What an unknown amount counts as. Without a floor a deal with no number would tie at zero forever. */
export const UNKNOWN_STAKE_CENTS = 500_000; // $5k
/** One huge old ask must not outrank everything: dollars stop counting past this. */
export const STAKE_CAP_CENTS = 200_000_000; // $2M
/** Overdue bonus: 1 + 0.2 x ln(1 + days), never more than this. About 19 days to reach the cap. */
export const AGE_FACTOR_CAP = 1.6;

/** How near a stage is to money in the bank. 1 = a signature away. */
export const STAGE_WEIGHT: Record<StageKey, number> = {
  contract_out: 1,
  offers_in: 0.9,
  offer_presented: 0.9,
  submitted: 0.7,
  stips: 0.6,
  application_in: 0.5,
  interested: 0.35,
  application_sent: 0.3,
  call_scheduled: 0.3,
  spoke_with_owner: 0.2,
  name_in: 0.12,
  // Funded: a routine check-in is low value; a renewal-ready advance is overridden to RENEWAL_WEIGHT.
  funded: 0.1,
  paying_off_soon: 0.6,
  paid_in_full: 0.7,
  default_workable: 0.1,
  default_bad: 0.08,
  legal_collections: 0.05,
  written_off: 0.03,
  declined: 0.04,
  lost: 0.06,
  killed: 0.04,
  dead: 0.03,
  not_interested: 0.02,
};

/** A renewal call on an advance that is 50%+ paid down. */
export const RENEWAL_WEIGHT = 0.8;
/** A merchant in default who promised to pay today. */
export const PROMISE_TODAY_WEIGHT = 0.9;

export type StakeBasis = "ask" | "approval" | "advance" | "outstanding" | "unknown";

export interface PriorityCtx {
  today: ISODate;
  /** Reads `promise_to_pay_at` as a calendar day. Defaults to UTC. */
  timezone?: string;
  /** Starred clients. Always ranked above everyone else. */
  hotIds?: ReadonlySet<string>;
}

export interface Priority {
  /** Higher = call first. Dollars x stage weight x age factor. */
  score: number;
  hot: boolean;
  /** The amount used, in cents, after the floor and cap. */
  atStakeCents: number;
  basis: StakeBasis;
  stageWeight: number;
  stageReason: string;
  daysOverdue: number;
  ageFactor: number;
  /** One plain-words sentence, for a tooltip. */
  explanation: string;
}

/** Days past due (0 when due today or later, or when there is no date). */
export function daysOverdue(card: Pick<ClientCard, "next_due_on">, today: ISODate): number {
  return card.next_due_on === null ? 0 : Math.max(0, diffDays(card.next_due_on, today));
}

/** 1 for something due today, growing slowly with every overdue day, capped. */
export function ageFactor(overdueDays: number): number {
  if (overdueDays <= 0) return 1;
  return Math.min(AGE_FACTOR_CAP, 1 + 0.2 * Math.log(1 + overdueDays));
}

interface Stake {
  cents: number;
  basis: StakeBasis;
}

/** The realistic size of the deal: what he can actually fund, never more than the merchant asked for. */
function pipelineStake(card: ClientCard): Stake {
  const ask = card.wanted_amount_cents;
  const approval = card.est_approval_cents;
  if (approval !== null && approval > 0 && (ask === null || approval <= ask)) {
    return { cents: approval, basis: "approval" };
  }
  if (ask !== null && ask > 0) return { cents: ask, basis: "ask" };
  return { cents: 0, basis: "unknown" };
}

function stakeFor(card: ClientCard, today: ISODate): Stake {
  const group = stageDef(card.stage).group;
  if (group === "trouble") {
    const terms = cardFundingTerms(card);
    if (terms) {
      // Remittances stopped when the merchant defaulted: measure what is left as of that day.
      const asOf = [card.defaulted_on, card.last_payment_on, today]
        .filter((d): d is ISODate => d !== null)
        .reduce((lo, d) => (d < lo ? d : lo), today);
      const left = balanceCents(terms, asOf < terms.fundedOn ? terms.fundedOn : asOf);
      if (left > 0) return { cents: left, basis: "outstanding" };
    }
  }
  if (group === "funded" && card.funding_amount_cents !== null && card.funding_amount_cents > 0) {
    // A renewal is about the size of the advance that just paid down.
    return { cents: card.funding_amount_cents, basis: "advance" };
  }
  return pipelineStake(card);
}

function isRenewalReady(card: ClientCard, today: ISODate): boolean {
  if (stageDef(card.stage).group !== "funded") return false;
  if (card.next_due_kind === "renewal") return true;
  const terms = cardFundingTerms(card);
  return (
    terms !== null &&
    card.funding_status === "active" &&
    paydownPct(terms, today) >= RENEWAL_PAYDOWN_PCT
  );
}

function promisedToday(card: ClientCard, ctx: PriorityCtx): boolean {
  if (stageDef(card.stage).group !== "trouble" || !card.promise_to_pay_at) return false;
  const when = new Date(card.promise_to_pay_at);
  if (Number.isNaN(when.getTime())) return false;
  return todayIn(ctx.timezone ?? "UTC", when) === ctx.today;
}

/** One plain phrase per stage, for the explanation. */
const STAGE_NOTE: Record<StageKey, string> = {
  contract_out: "closest to funding",
  offers_in: "closest to funding",
  offer_presented: "closest to funding",
  submitted: "in underwriting",
  stips: "in underwriting",
  application_in: "in underwriting",
  interested: "a live prospect",
  application_sent: "a live prospect",
  call_scheduled: "a live prospect",
  spoke_with_owner: "a live prospect",
  name_in: "only a name so far",
  funded: "routine check-in",
  paying_off_soon: "near payoff",
  paid_in_full: "the hottest lead you own",
  default_workable: "a default that can still be worked",
  default_bad: "a bad default",
  legal_collections: "with counsel or a collector",
  written_off: "written off",
  declined: "a long shot",
  lost: "a long shot",
  killed: "a long shot",
  dead: "a long shot",
  not_interested: "a long shot",
};

function stageWeightFor(card: ClientCard, ctx: PriorityCtx): { weight: number; reason: string } {
  const def = stageDef(card.stage);
  const base = STAGE_WEIGHT[card.stage];
  if (promisedToday(card, ctx)) {
    return {
      weight: Math.max(base, PROMISE_TODAY_WEIGHT),
      reason: `${def.label}, promised to pay today`,
    };
  }
  if (isRenewalReady(card, ctx.today)) {
    return {
      weight: Math.max(base, RENEWAL_WEIGHT),
      reason: `${def.label}, ready to renew (${RENEWAL_PAYDOWN_PCT}%+ paid down)`,
    };
  }
  return { weight: base, reason: `${def.label} (${STAGE_NOTE[card.stage]})` };
}

const BASIS_WORDS: Record<StakeBasis, string> = {
  ask: "what he wants",
  approval: "what funders would approve",
  advance: "the funded advance; a renewal is about that size",
  outstanding: "payback still outstanding when he defaulted",
  unknown: "no amount on file, so the minimum is counted",
};

/** The score for one client, with the working shown. */
export function priorityOf(card: ClientCard, ctx: PriorityCtx): Priority {
  const stake = stakeFor(card, ctx.today);
  // A known amount counts as it is (even a small one); only a missing amount gets the floor.
  const atStakeCents = Math.min(
    stake.cents > 0 ? stake.cents : UNKNOWN_STAKE_CENTS,
    STAKE_CAP_CENTS,
  );
  const { weight, reason } = stageWeightFor(card, ctx);
  const overdue = daysOverdue(card, ctx.today);
  const age = ageFactor(overdue);
  const hot = ctx.hotIds?.has(card.id) ?? false;
  const score = (atStakeCents / 100) * weight * age;

  const explanation =
    `${formatMoneyCompact(atStakeCents)} at stake (${BASIS_WORDS[stake.basis]}). ` +
    `${reason} counts x ${weight}. ` +
    (overdue > 0
      ? `${overdue} day${overdue === 1 ? "" : "s"} overdue adds x ${age.toFixed(2)}. `
      : "Due on time, x 1. ") +
    `That makes priority ${Math.round(score).toLocaleString("en-US")}.` +
    (hot ? " Starred, so it goes first." : "");
  return {
    score,
    hot,
    atStakeCents,
    basis: stake.basis,
    stageWeight: weight,
    stageReason: reason,
    daysOverdue: overdue,
    ageFactor: age,
    explanation,
  };
}

export interface Ranked {
  card: ClientCard;
  priority: Priority;
}

export type SortMode = "biggest" | "oldest";

/** Whole-number score for comparisons: floating-point noise must never decide an order. */
const key = (p: Priority) => Math.round(p.score * 100);

const byName = (a: ClientCard, b: ClientCard) =>
  a.business_name.localeCompare(b.business_name) || a.id.localeCompare(b.id);

function compareDue(a: ClientCard, b: ClientCard): number {
  return (a.next_due_on ?? "9999-12-31").localeCompare(b.next_due_on ?? "9999-12-31");
}

/** Biggest first: starred, then score, then the one waiting longest, then name. A total, stable order. */
export function compareBiggest(a: Ranked, b: Ranked): number {
  if (a.priority.hot !== b.priority.hot) return a.priority.hot ? -1 : 1;
  return key(b.priority) - key(a.priority) || compareDue(a.card, b.card) || byName(a.card, b.card);
}

/** Oldest first: starred, then the date it fell due, then score (so a tie goes to the bigger deal), then name. */
export function compareOldest(a: Ranked, b: Ranked): number {
  if (a.priority.hot !== b.priority.hot) return a.priority.hot ? -1 : 1;
  return compareDue(a.card, b.card) || key(b.priority) - key(a.priority) || byName(a.card, b.card);
}

/** Score every card once, then order them. Does not mutate the input. */
export function rankCards(
  cards: readonly ClientCard[],
  ctx: PriorityCtx,
  mode: SortMode = "biggest",
): Ranked[] {
  const ranked = cards.map((card) => ({ card, priority: priorityOf(card, ctx) }));
  return ranked.sort(mode === "oldest" ? compareOldest : compareBiggest);
}

// ---------------------------------------------------------------------------------------------
// Spreading a pile of overdue work over the next few business days

export function isBusinessDay(d: ISODate): boolean {
  const dow = parseISODate(d).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** The first `days` business days, counting today when today is one (a weekend starts on Monday). */
export function businessDaySlots(today: ISODate, days: number): ISODate[] {
  if (!Number.isInteger(days) || days < 1) throw new RangeError("days must be a whole number >= 1");
  const first = isBusinessDay(today) ? today : addBusinessDays(today, 1);
  return Array.from({ length: days }, (_, i) => addBusinessDays(first, i));
}

export interface SpreadPlan {
  assignments: { id: string; dueOn: ISODate }[];
  /** Only days that got someone, in date order. */
  perDay: { date: ISODate; count: number }[];
}

/**
 * `ids` must already be in priority order (biggest deal first). They are dealt out evenly across the
 * slots, earliest day first, so the biggest deals land earliest and no day is overloaded. With fewer
 * clients than days it is one a day.
 */
export function planSpread(ids: readonly string[], today: ISODate, days: number): SpreadPlan {
  const slots = businessDaySlots(today, days);
  const base = Math.floor(ids.length / slots.length);
  const extra = ids.length % slots.length;
  const assignments: SpreadPlan["assignments"] = [];
  const perDay: SpreadPlan["perDay"] = [];
  let next = 0;
  slots.forEach((date, i) => {
    const count = base + (i < extra ? 1 : 0);
    for (const id of ids.slice(next, next + count)) assignments.push({ id, dueOn: date });
    next += count;
    if (count > 0) perDay.push({ date, count });
  });
  return { assignments, perDay };
}

// ---------------------------------------------------------------------------------------------
// Snooze guard

/** Underwriting deals are the ones that die when they are left alone: Application in ... Contract out. */
export function isUnderwriting(stage: StageKey): boolean {
  return stageDef(stage).group === "underwriting";
}

export const SNOOZE_GUARD_DAYS = 7;

/** Burying a live deal for more than a week is allowed, but he is asked why. */
export function snoozeNeedsReason(stage: StageKey, today: ISODate, dueOn: ISODate): boolean {
  return isUnderwriting(stage) && diffDays(today, dueOn) > SNOOZE_GUARD_DAYS;
}

// ---------------------------------------------------------------------------------------------
// Bulk "reschedule all overdue": who moves where (pure; the server runs this and the dialog previews it)

/** One call moves at most this many clients. */
export const MAX_BULK = 200;
export const BULK_NOTE = "Rescheduled in bulk";
export const BULK_DAY_CHOICES = [3, 5, 10, 20] as const;
export const MAX_BULK_DAYS = 60;

/**
 * The timer kinds `set_follow_up` can move. A booked call or a funder chase is not replaced by it, so a client
 * whose overdue timer is one of those would still be overdue afterwards: leave those for a human.
 */
const MOVABLE_KINDS: ReadonlySet<string> = new Set(["follow_up", "check_in", "renewal"]);

export interface BulkOptions {
  days: number;
  /** Leave Application in ... Contract out deals overdue: they need a call, not a new date. */
  keepUnderwriting: boolean;
  /** Clients whose overdue timer is a booked call or a funder chase hiding behind a follow-up. */
  blockedIds?: ReadonlySet<string>;
}

export interface BulkPlan extends SpreadPlan {
  /** Underwriting deals left overdue on purpose. */
  keptUnderwriting: ClientCard[];
  /** Overdue but not movable here (a passed booked call, a funder chase). */
  needHands: ClientCard[];
  /** Movable but past the per-call cap: still overdue, run it again. */
  overCap: number;
  /** The clients being moved, in the order they were dealt out. */
  ordered: ClientCard[];
}

/** Overdue and not do-not-contact: the pile "Reschedule all" is about. */
export function overdueCards(cards: readonly ClientCard[], today: ISODate): ClientCard[] {
  return cards.filter(
    (c) => c.next_due_on !== null && c.next_due_on < today && c.contact_status !== "dnc",
  );
}

/** Pure: who moves where. The server runs exactly this; the dialog previews with it. */
export function planBulk(
  cards: readonly ClientCard[],
  ctx: PriorityCtx,
  opts: BulkOptions,
): BulkPlan {
  const overdue = overdueCards(cards, ctx.today);
  const needHands = overdue.filter(
    (c) => (c.next_due_kind && !MOVABLE_KINDS.has(c.next_due_kind)) || opts.blockedIds?.has(c.id),
  );
  const handSet = new Set(needHands.map((c) => c.id));
  const movable = overdue.filter((c) => !handSet.has(c.id));
  const keptUnderwriting = opts.keepUnderwriting
    ? movable.filter((c) => isUnderwriting(c.stage))
    : [];
  const keptSet = new Set(keptUnderwriting.map((c) => c.id));
  const candidates = movable.filter((c) => !keptSet.has(c.id));
  // Biggest deals first, so they land on the earliest days.
  const ranked = rankCards(candidates, ctx, "biggest").map((r) => r.card);
  const ordered = ranked.slice(0, MAX_BULK);
  const spread = planSpread(
    ordered.map((c) => c.id),
    ctx.today,
    opts.days,
  );
  return {
    ...spread,
    keptUnderwriting,
    needHands,
    overCap: ranked.length - ordered.length,
    ordered,
  };
}
