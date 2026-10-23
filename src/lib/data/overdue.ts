import type { Db } from "../db";
import { formatDate } from "../format";
import type { ISODate } from "../mca/dates";
import type { ContactStatus } from "../mca/contact";
import type { StageKey } from "../mca/stages";
import * as m from "./mutations";
import { BULK_NOTE, overdueCards, planBulk } from "./priority";
import { listCards } from "./queries";
import { noteSchema } from "./schemas";
import type { ClientCard, UserContext } from "./types";

/**
 * Server-side database work for the Today power tools: the bulk "reschedule all overdue", snooze-with-reason,
 * the snooze-count badge, why a follow-up is due, and the lightweight client list behind search. The pure
 * planning (who moves where) lives in priority.ts so the browser can preview it with the same code.
 */

export interface BulkInput {
  days: number;
  keepUnderwriting: boolean;
  /** Starred clients (they are remembered in the browser, so the browser tells us). */
  hotIds?: string[];
}

export interface BulkResult {
  moved: number;
  perDay: { date: ISODate; count: number }[];
  keptUnderwriting: number;
  needHands: number;
  overCap: number;
}

/** Overdue clients with an open timer `set_follow_up` would leave behind (a passed booked call, a funder chase). */
export async function blockedByOtherTimers(
  q: Db,
  ids: readonly string[],
  today: ISODate,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await q.query<{ client_id: string }>(
    `select distinct client_id from timers
      where done_at is null and due_on < $2::date
        and kind not in ('follow_up', 'check_in', 'renewal')
        and client_id = any($1::uuid[])`,
    [ids, today],
  );
  return new Set(rows.map((r) => r.client_id));
}

/**
 * Move every client with the existing `set_follow_up()` SQL function, in ONE statement: if any single
 * client fails (deleted meanwhile, someone else's id), the whole transaction rolls back and nothing moved.
 */
export async function applyMoves(
  q: Db,
  moves: readonly { id: string; dueOn: ISODate }[],
  note: string = BULK_NOTE,
): Promise<number> {
  if (moves.length === 0) return 0;
  const { rows } = await q.query<{ n: number }>(
    `select count(*)::int as n from (
       select set_follow_up(t.c, t.d, $3) from unnest($1::uuid[], $2::date[]) as t(c, d)
     ) moved`,
    [moves.map((m) => m.id), moves.map((m) => m.dueOn), note],
  );
  return rows[0]?.n ?? 0;
}

/** Runs inside `db.withUser`: reads the cards, plans, moves. The caller's transaction makes it all-or-nothing. */
export async function bulkReschedule(
  q: Db,
  ctx: UserContext,
  input: BulkInput,
): Promise<BulkResult> {
  const cards = await listCards(q);
  const overdueIds = overdueCards(cards, ctx.today).map((c) => c.id);
  const blockedIds = await blockedByOtherTimers(q, overdueIds, ctx.today);
  const plan = planBulk(
    cards,
    { today: ctx.today, timezone: ctx.timezone, hotIds: new Set(input.hotIds ?? []) },
    { days: input.days, keepUnderwriting: input.keepUnderwriting, blockedIds },
  );
  const moved = await applyMoves(q, plan.assignments);
  return {
    moved,
    perDay: plan.perDay,
    keptUnderwriting: plan.keptUnderwriting.length,
    needHands: plan.needHands.length,
    overCap: plan.overCap,
  };
}

export interface SnoozeInput {
  clientId: string;
  dueOn: ISODate;
  /** One line. Blank snoozes without a note. */
  reason: string;
}

/** Snooze a client and record why, in the caller's one transaction: both happen or neither does. */
export async function snoozeWithReason(
  q: Db,
  ctx: UserContext,
  input: SnoozeInput,
): Promise<ClientCard> {
  const card = await m.setFollowUp(q, { clientId: input.clientId, dueOn: input.dueOn }, ctx);
  if (input.reason) {
    await m.addNote(
      q,
      noteSchema.parse({
        clientId: input.clientId,
        body: `Snoozed until ${formatDate(input.dueOn, ctx.today)}: ${input.reason}`,
      }),
    );
  }
  return card;
}

/**
 * How many times each client's date was pushed in the last 14 days, from the timeline, in ONE query.
 * A bulk reschedule is not a snooze, so it does not count.
 */
export async function snoozeCounts(q: Db, ids: readonly string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {};
  const { rows } = await q.query<{ client_id: string; n: number }>(
    `select client_id, count(*)::int as n from activities
      where kind = 'timer' and body like 'Follow up set for%'
        and body not like $2
        and occurred_at > now() - interval '14 days'
        and client_id = any($1::uuid[])
      group by client_id`,
    [ids, `%— ${BULK_NOTE}`],
  );
  return Object.fromEntries(rows.map((r) => [r.client_id, r.n]));
}

export interface FollowUpReason {
  kind: string;
  note: string;
}

/** Why each client's next date exists: the note on its earliest open timer (same pick as the card's next date). */
export async function followUpReasons(
  q: Db,
  ids: readonly string[],
): Promise<Record<string, FollowUpReason>> {
  if (ids.length === 0) return {};
  const { rows } = await q.query<{ client_id: string; kind: string; note: string }>(
    `select distinct on (client_id) client_id, kind, note from timers
      where done_at is null and client_id = any($1::uuid[])
      order by client_id, due_on, created_at`,
    [ids],
  );
  return Object.fromEntries(rows.map((r) => [r.client_id, { kind: r.kind, note: r.note }]));
}

/** What the search palette needs to know about a client: no notes, positions or funding. */
export interface DirectoryRow {
  id: string;
  business_name: string;
  dba: string;
  contact_name: string;
  phone: string;
  email: string;
  stage: StageKey;
  contact_status: ContactStatus;
  wanted_amount_cents: number | null;
  last_call_at: string | null;
  next_due_on: ISODate | null;
}

export async function clientDirectory(q: Db): Promise<DirectoryRow[]> {
  const { rows } = await q.query<{ j: DirectoryRow }>(
    `select to_jsonb(x) as j from (
       select c.id, c.business_name, c.dba, c.contact_name, c.phone, c.email, c.stage, c.contact_status,
              (select k.wanted_amount_cents from client_asks k where k.client_id = c.id
                order by k.created_at desc limit 1) as wanted_amount_cents,
              (select max(a.occurred_at) from activities a where a.client_id = c.id and a.kind = 'call') as last_call_at,
              (select min(t.due_on) from timers t where t.client_id = c.id and t.done_at is null) as next_due_on
         from clients c
        where not exists (select 1 from trashed_clients t where t.client_id = c.id)
        order by lower(c.business_name), c.id
        limit 20000
     ) x`,
  );
  return rows.map((r) => r.j);
}
