import type { ClientCard } from "@/lib/data/types";
import {
  bucketFor,
  BUCKET_ORDER,
  diffDays,
  dueFromPreset,
  todayIn,
  type BucketKey,
  type ISODate,
} from "@/lib/mca/dates";
import { paydownPct, type FundingTerms } from "@/lib/mca/funding";
import {
  defaultTimers,
  foldStage,
  STAGE_KEYS,
  type FollowUpRule,
  type StageGroup,
  type StageKey,
} from "@/lib/mca/stages";
import { formatMoneyCompact } from "@/lib/money";

export type BoardView = "pipeline" | "followups";

export function parseView(v: string | string[] | undefined): BoardView {
  return v === "followups" ? "followups" : "pipeline";
}

/**
 * The last Board view he used lives in a cookie, not localStorage: the server reads it, so the page
 * arrives in the right view with no flash of the other one (I-9). Per browser, like the other
 * Board preferences.
 */
export const VIEW_COOKIE = "isaac_board_view";

/** `?view=` wins when it names a view (a link or a reload); otherwise the remembered one; otherwise Pipeline. */
export function resolveView(
  param: string | string[] | undefined,
  remembered: string | undefined,
): BoardView {
  if (param === "followups" || param === "pipeline") return param;
  return parseView(remembered);
}

/** No date at all counts as overdue: a client with no next step is the one most likely to be forgotten. */
export function isOverdue(card: ClientCard, today: ISODate): boolean {
  return card.next_due_on === null || card.next_due_on < today;
}

export interface CardFilter {
  query: string;
  overdueOnly: boolean;
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Every whitespace-separated word must hit the business, DBA, contact or the phone's digits. */
export function matchesQuery(card: ClientCard, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${card.business_name} ${card.dba} ${card.contact_name}`.toLowerCase();
  const phone = digitsOf(card.phone);
  return words.every((w) => {
    if (text.includes(w)) return true;
    const d = digitsOf(w);
    return d.length >= 3 && phone.includes(d);
  });
}

export function filterCards(
  cards: readonly ClientCard[],
  filter: CardFilter,
  today: ISODate,
): ClientCard[] {
  return cards.filter(
    (c) => (!filter.overdueOnly || isOverdue(c, today)) && matchesQuery(c, filter.query),
  );
}

/** Most urgent first; a missing date sorts to the very top. */
export function compareCards(a: ClientCard, b: ClientCard): number {
  if (a.next_due_on !== b.next_due_on) {
    if (a.next_due_on === null) return -1;
    if (b.next_due_on === null) return 1;
    return a.next_due_on < b.next_due_on ? -1 : 1;
  }
  const an = a.business_name.toLowerCase();
  const bn = b.business_name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Every stage is a key, empty or not, so a card can never fall between columns. */
export function groupByStage(cards: readonly ClientCard[]): Record<StageKey, ClientCard[]> {
  const out = Object.fromEntries(STAGE_KEYS.map((k) => [k, [] as ClientCard[]])) as Record<
    StageKey,
    ClientCard[]
  >;
  for (const c of cards) out[foldStage(c.stage)].push(c);
  for (const k of STAGE_KEYS) out[k].sort(compareCards);
  return out;
}

export function bucketOf(card: ClientCard, today: ISODate): BucketKey {
  return card.next_due_on === null ? "overdue" : bucketFor(card.next_due_on, today);
}

export function groupByBucket(
  cards: readonly ClientCard[],
  today: ISODate,
): Record<BucketKey, ClientCard[]> {
  const out = Object.fromEntries(BUCKET_ORDER.map((k) => [k, [] as ClientCard[]])) as Record<
    BucketKey,
    ClientCard[]
  >;
  for (const c of cards) out[bucketOf(c, today)].push(c);
  for (const k of BUCKET_ORDER) out[k].sort(compareCards);
  return out;
}

/** Overdue is history and Later is past the 36-month limit: neither is a date Isaac can choose. */
export type DropBucket = Exclude<BucketKey, "overdue" | "later">;

export function isDropBucket(key: BucketKey): key is DropBucket {
  return key !== "overdue" && key !== "later";
}

export function bucketDueDate(bucket: DropBucket, today: ISODate): ISODate {
  return bucket === "today" ? today : dueFromPreset(bucket, today);
}

// ---- optimistic updates -------------------------------------------------------------------

export function optimisticMove(card: ClientCard, stage: StageKey, today: ISODate): ClientCard {
  const due = defaultTimers(stage, { today })[0]?.dueOn ?? card.next_due_on;
  return { ...withDue(card, due), stage };
}

/**
 * What a drag into a follow-up column looks like before the server answers. A renewal call or check-in that is
 * already due earlier keeps its own date (the drag only moves the follow-up), like a booked call.
 */
export function optimisticDue(card: ClientCard, dueOn: ISODate): ClientCard {
  if (
    (card.next_due_kind === "renewal" || card.next_due_kind === "check_in") &&
    card.next_due_on !== null &&
    card.next_due_on <= dueOn
  )
    return { ...card };
  return withDue(card, dueOn);
}

/** A booked call is never replaced by a follow-up, so it keeps winning while it is the earlier date. */
function withDue(card: ClientCard, dueOn: ISODate | null): ClientCard {
  if (
    dueOn === null ||
    (card.next_due_kind === "scheduled_call" &&
      card.next_due_on !== null &&
      card.next_due_on <= dueOn)
  )
    return { ...card };
  return { ...card, next_due_on: dueOn, next_due_kind: "follow_up" };
}

export function replaceCard(cards: readonly ClientCard[], next: ClientCard): ClientCard[] {
  return cards.map((c) => (c.id === next.id ? next : c));
}

/** Undo an optimistic edit, but only if nothing newer touched the card in the meantime. */
export function revertCard(
  cards: readonly ClientCard[],
  original: ClientCard,
  optimistic: ClientCard,
): ClientCard[] {
  return cards.map((c) => (c.id === original.id && c === optimistic ? original : c));
}

export function sameCard(a: ClientCard, b: ClientCard): boolean {
  const keys = Object.keys(a) as (keyof ClientCard)[];
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * Fresh server rows win, except for cards with a request in flight (their optimistic state stays
 * until the answer arrives) — and unchanged cards keep their object identity so React.memo holds.
 */
export function mergeServerCards(
  local: readonly ClientCard[],
  server: readonly ClientCard[],
  pending: ReadonlySet<string>,
): ClientCard[] {
  const byId = new Map(local.map((c) => [c.id, c]));
  return server.map((s) => {
    const l = byId.get(s.id);
    if (!l) return s;
    if (pending.has(s.id)) return l;
    return sameCard(l, s) ? l : s;
  });
}

export function sameCards(a: readonly ClientCard[], b: readonly ClientCard[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

// ---- column summaries ---------------------------------------------------------------------

export interface Summary {
  /** What `cents` adds up: what merchants asked for, or what was advanced to them. */
  kind: "wanted" | "advanced";
  cents: number;
}

export function summaryKind(group: StageGroup): Summary["kind"] {
  return group === "funded" || group === "trouble" ? "advanced" : "wanted";
}

export function summarize(cards: readonly ClientCard[], group: StageGroup): Summary {
  const kind = summaryKind(group);
  let cents = 0;
  for (const c of cards)
    cents += (kind === "advanced" ? c.funding_amount_cents : c.wanted_amount_cents) ?? 0;
  return { kind, cents };
}

// ---- card details -------------------------------------------------------------------------

export const FUNDED_STAGES: readonly StageKey[] = ["funded", "paying_off_soon", "paid_in_full"];
export const STIP_STAGES: readonly StageKey[] = ["application_in", "stips", "submitted"];
/** Stages where the signed application is in hand, so "App in <date>" means something. */
export const APP_IN_STAGES: readonly StageKey[] = [
  "application_in",
  "stips",
  "submitted",
  "offers_in",
  "offer_presented",
  "contract_out",
];

/** Percent of the payback already remitted, or null when the card has no usable funding terms. */
export function cardPaydown(card: ClientCard, today: ISODate): number | null {
  if (!FUNDED_STAGES.includes(card.stage)) return null;
  if (card.stage === "paid_in_full") return 100;
  const { funded_on, funding_amount_cents, factor_rate, funding_payment_cents, funding_frequency } =
    card;
  if (
    funded_on === null ||
    funding_amount_cents === null ||
    factor_rate === null ||
    funding_payment_cents === null ||
    funding_frequency === null
  )
    return null;
  const terms: FundingTerms = {
    fundedOn: funded_on,
    amountCents: funding_amount_cents,
    factorRate: factor_rate,
    paymentCents: funding_payment_cents,
    frequency: funding_frequency,
    paidBackOverrideCents: card.paid_back_override_cents,
  };
  return Math.max(0, Math.min(100, paydownPct(terms, today)));
}

// ---- wording ------------------------------------------------------------------------------

/** "3d ago" for a timestamp, counted in Isaac's calendar days so server and browser always agree. */
export function agoShort(iso: string, today: ISODate, timezone: string): string {
  const days = diffDays(todayIn(timezone, new Date(iso)), today);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.round(days / 7)}w ago`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** "Last call 3d ago", plus "last touch" when a text or email came after the last call. */
export function lastContact(
  card: ClientCard,
  today: ISODate,
  timezone: string,
): { call: string; touch: string | null } {
  const call = card.last_call_at
    ? `Last call ${agoShort(card.last_call_at, today, timezone)}`
    : "No calls yet";
  const newer =
    card.last_touch_at !== null &&
    (card.last_call_at === null || Date.parse(card.last_touch_at) > Date.parse(card.last_call_at));
  return {
    call,
    touch:
      newer && card.last_touch_at
        ? `last touch ${agoShort(card.last_touch_at, today, timezone)}`
        : null,
  };
}

/** "1 position", "2 positions · $51k balance". */
export function positionsText(card: ClientCard): string | null {
  const n = card.position_count;
  if (n <= 0) return null;
  const base = `${n} position${n === 1 ? "" : "s"}`;
  return card.position_balance_cents > 0
    ? `${base} · ${formatMoneyCompact(card.position_balance_cents)} balance`
    : base;
}

export function timerText(rule: FollowUpRule): string {
  switch (rule.kind) {
    case "bdays":
      return rule.days === 1 ? "next business day" : `in ${rule.days} business days`;
    case "days":
      return rule.days === 1 ? "tomorrow" : `in ${rule.days} days`;
    case "months":
      return `in ${rule.months} months`;
    case "funded":
      return "30-day check-in + renewal call";
    case "lost":
      return "half their term, else 6 months";
  }
}

export const STAGE_MONEY_LABEL: Record<Summary["kind"], string> = {
  wanted: "asked for in total",
  advanced: "advanced in total",
};
