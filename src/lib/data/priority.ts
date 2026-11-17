import { addBusinessDays, diffDays, parseISODate, type ISODate } from "../mca/dates";
import { foldStage, stageDef, type StageKey } from "../mca/stages";
import { formatMoneyCompact } from "../money";
import type { ClientCard } from "./types";

/**
 * "Who should I call first?" — pure ranking, no I/O.
 *
 *   score = dollars the merchant wants  x  how close the stage is to a complete file  x  how long it has been overdue
 *
 * A starred ("hot") client always goes first. Nothing here reads the database or the clock: callers
 * pass `today`.
 */

/** What an unknown amount counts as. Without a floor a merchant with no number would tie at zero forever. */
export const UNKNOWN_STAKE_CENTS = 500_000; // $5k
/** One huge ask must not outrank everything: dollars stop counting past this. */
export const STAKE_CAP_CENTS = 200_000_000; // $2M
/** Overdue bonus: 1 + 0.2 x ln(1 + days), never more than this. About 19 days to reach the cap. */
export const AGE_FACTOR_CAP = 1.6;

/** How near a stage is to a complete file. 1 = nothing left to chase. */
const STAGE_WEIGHT: Partial<Record<StageKey, number>> = {
  application_in: 0.6,
  interested: 0.35,
  dead: 0.03,
};

export type StakeBasis = "ask" | "unknown";

export interface PriorityCtx {
  today: ISODate;
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
  /** Why it is in the line, in plain words: the stage and the due day ("Application in, due today."). */
  summary: string;
  /** The amount and the summary in plain words, for a tooltip and the list's note. No working is shown. */
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

/** The size of the merchant's ask: what they said they want. */
function stakeFor(card: ClientCard): Stake {
  const ask = card.wanted_amount_cents;
  if (ask !== null && ask > 0) return { cents: ask, basis: "ask" };
  return { cents: 0, basis: "unknown" };
}

/** One plain phrase per stage, for the explanation. */
const STAGE_NOTE: Partial<Record<StageKey, string>> = {
  application_in: "documents still coming in",
  interested: "a live prospect",
  dead: "a long shot",
};

function stageWeightFor(card: ClientCard): { weight: number; reason: string } {
  const stage = foldStage(card.stage);
  return {
    weight: STAGE_WEIGHT[stage] ?? 0,
    reason: `${stageDef(stage).label} (${STAGE_NOTE[stage] ?? "worked"})`,
  };
}

/** When it is due, in words. */
function dueWords(card: Pick<ClientCard, "next_due_on">, overdue: number, today: ISODate): string {
  if (card.next_due_on === null) return "no follow-up date";
  if (overdue > 0) return `${overdue} day${overdue === 1 ? "" : "s"} overdue`;
  return card.next_due_on === today ? "due today" : "not due yet";
}

/** The score for one client, with the working shown. */
export function priorityOf(card: ClientCard, ctx: PriorityCtx): Priority {
  const stake = stakeFor(card);
  // A known amount counts as it is (even a small one); only a missing amount gets the floor.
  const atStakeCents = Math.min(
    stake.cents > 0 ? stake.cents : UNKNOWN_STAKE_CENTS,
    STAKE_CAP_CENTS,
  );
  const { weight, reason } = stageWeightFor(card);
  const overdue = daysOverdue(card, ctx.today);
  const age = ageFactor(overdue);
  const hot = ctx.hotIds?.has(card.id) ?? false;
  const score = (atStakeCents / 100) * weight * age;

  // what a rep reads: no weights, no score, only the facts the order comes from
  const summary =
    `${stageDef(foldStage(card.stage)).label}, ${dueWords(card, overdue, ctx.today)}.` +
    (hot ? " Starred, so it goes first." : "");
  const explanation =
    (stake.basis === "ask"
      ? `${formatMoneyCompact(atStakeCents)} at stake (what they want). `
      : "No amount on file yet. ") + summary;
  return {
    score,
    hot,
    atStakeCents,
    basis: stake.basis,
    stageWeight: weight,
    stageReason: reason,
    daysOverdue: overdue,
    ageFactor: age,
    summary,
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

/** Oldest first: starred, then the date it fell due, then score (so a tie goes to the bigger ask), then name. */
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
 * `ids` must already be in priority order (biggest ask first). They are dealt out evenly across the
 * slots, earliest day first, so the biggest asks land earliest and no day is overloaded. With fewer
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

/** A merchant whose application is in is the one that goes cold when left alone: the documents are still coming. */
export function isApplicationIn(stage: StageKey): boolean {
  return stageDef(stage).group === "application";
}

export const SNOOZE_GUARD_DAYS = 7;

/** Burying a merchant whose application is in for more than a week is allowed, but he is asked why. */
export function snoozeNeedsReason(stage: StageKey, today: ISODate, dueOn: ISODate): boolean {
  return isApplicationIn(stage) && diffDays(today, dueOn) > SNOOZE_GUARD_DAYS;
}

// ---------------------------------------------------------------------------------------------
// Bulk "reschedule all overdue": who moves where (pure; the server runs this and the dialog previews it)

/** One call moves at most this many clients. */
export const MAX_BULK = 200;
export const BULK_NOTE = "Rescheduled in bulk";
export const BULK_DAY_CHOICES = [3, 5, 10, 20] as const;
export const MAX_BULK_DAYS = 60;

/**
 * The timer kinds `set_follow_up` can move. A booked call is not replaced by it, so a client whose overdue timer
 * is one would still be overdue afterwards: leave those for a human.
 */
const MOVABLE_KINDS: ReadonlySet<string> = new Set(["follow_up"]);

export interface BulkOptions {
  days: number;
  /** Leave merchants whose application is in overdue: they need a call, not a new date. */
  keepApplicationIn: boolean;
  /** Clients whose overdue timer is a booked call hiding behind a follow-up. */
  blockedIds?: ReadonlySet<string>;
}

export interface BulkPlan extends SpreadPlan {
  /** Merchants whose application is in, left overdue on purpose. */
  keptApplicationIn: ClientCard[];
  /** Overdue but not movable here (a passed booked call). */
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
  const keptApplicationIn = opts.keepApplicationIn
    ? movable.filter((c) => isApplicationIn(c.stage))
    : [];
  const keptSet = new Set(keptApplicationIn.map((c) => c.id));
  const candidates = movable.filter((c) => !keptSet.has(c.id));
  // Biggest asks first, so they land on the earliest days.
  const ranked = rankCards(candidates, ctx, "biggest").map((r) => r.card);
  const ordered = ranked.slice(0, MAX_BULK);
  const spread = planSpread(
    ordered.map((c) => c.id),
    ctx.today,
    opts.days,
  );
  return {
    ...spread,
    keptApplicationIn,
    needHands,
    overCap: ranked.length - ordered.length,
    ordered,
  };
}
