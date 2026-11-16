import type { Db } from "../db";
import type { DealCard, DealFilter, DealRow } from "./types";

const json = async <T>(q: Db, sql: string, params: unknown[] = []): Promise<T[]> =>
  (await q.query<{ j: T }>(sql, params)).rows.map((r) => r.j);

/**
 * One deal per row with everything a board line needs. RLS decides who sees which rows (rep: own; ops: the queue;
 * manager: all), so the same query serves every role. The WHERE is a fixed allow-list keyed by filter name — no
 * SQL is ever built from input.
 */
const CARD_SELECT = `
  select to_jsonb(d) || jsonb_build_object(
    'status', app.deal_status(d),
    'business_name', c.business_name, 'contact_name', c.contact_name, 'phone', c.phone, 'email', c.email,
    'industry', c.industry, 'state', c.state, 'stage', c.stage,
    'rep_name', u.name, 'rep_email', u.email,
    'lenders_sent', (select count(*) from submissions s where s.deal_id = d.id),
    'lenders_responded', (select count(*) from submissions s where s.deal_id = d.id and s.responded_at is not null),
    'lenders_approved', (select count(*) from submissions s where s.deal_id = d.id and s.status in ('approved','revised','contracts_out','contracts_in','funding_call','funded')),
    'lenders_declined', (select count(*) from submissions s where s.deal_id = d.id and s.status = 'declined'),
    'best_offer_cents', (select o.amount_cents from offers o where o.deal_id = d.id and o.status in ('open','presented','accepted') order by o.factor_rate, o.amount_cents desc limit 1),
    'best_factor_rate', (select o.factor_rate from offers o where o.deal_id = d.id and o.status in ('open','presented','accepted') order by o.factor_rate, o.amount_cents desc limit 1),
    'approval_expires_on', (select min(s.approval_expires_on) from submissions s where s.deal_id = d.id and s.status in ('approved','revised')),
    'funded_cents', (select f.amount_cents from fundings f where f.deal_id = d.id order by f.funded_on desc limit 1),
    'commission_cents', (select f.commission_cents from fundings f where f.deal_id = d.id order by f.funded_on desc limit 1),
    'last_activity_at', (select max(a.occurred_at) from activities a where a.client_id = d.client_id)
  ) as j
  from deals d
  join clients c on c.id = d.client_id
  join app_users u on u.id = d.user_id
  where not exists (select 1 from trashed_clients tc where tc.client_id = d.client_id)`;

const FILTERS: Record<DealFilter, string> = {
  all: "",
  mine: "and d.user_id = app.current_user_id()",
  live: "and d.outcome = 'open'",
  working: "and app.deal_status(d) = 'working'",
  working_ops: "and app.deal_status(d) = 'working_ops'",
  kicked_back: "and app.deal_status(d) = 'kicked_back'",
  pending_lenders: "and app.deal_status(d) = 'pending_lenders'",
  stips_needed: "and app.deal_status(d) = 'stips_needed'",
  needs_pitch: "and app.deal_status(d) = 'needs_pitch'",
  pitched: "and app.deal_status(d) = 'pitched'",
  contracts_out: "and app.deal_status(d) = 'contracts_out'",
  contracts_in: "and app.deal_status(d) = 'contracts_in'",
  funding_call: "and app.deal_status(d) = 'funding_call'",
  funded: "and d.outcome = 'funded'",
  declined_by_all: "and app.deal_status(d) = 'declined_by_all'",
  declined: "and d.outcome = 'declined'",
  lost: "and d.outcome = 'lost'",
  dead: "and d.outcome = 'dead'",
  expiring: `and d.outcome = 'open' and exists (select 1 from submissions s where s.deal_id = d.id
             and s.status in ('approved','revised') and s.approval_expires_on <= current_date + 7)`,
  no_response_24h: `and d.outcome = 'open' and exists (select 1 from submissions s where s.deal_id = d.id
             and s.status = 'sent' and s.created_at < now() - interval '24 hours')`,
  reshop: `and d.outcome = 'open' and app.deal_status(d) = 'declined_by_all'`,
};

export function isDealFilter(v: string): v is DealFilter {
  return Object.hasOwn(FILTERS, v);
}

export interface DealListOpts {
  /** Only this rep's deals (a manager's or ops' filter). */
  repId?: string | null;
  /** Only deals with a lender row for this funder. */
  funderId?: string | null;
}

export async function listDeals(
  q: Db,
  filter: DealFilter = "live",
  opts: DealListOpts = {},
): Promise<DealCard[]> {
  const where = FILTERS[filter];
  // the two optional narrowings are parameters, never text
  return json<DealCard>(
    q,
    `${CARD_SELECT} ${where}
       and ($1::uuid is null or d.user_id = $1::uuid)
       and ($2::uuid is null or exists (select 1 from submissions s where s.deal_id = d.id and s.funder_id = $2::uuid))
     order by d.updated_at desc`,
    [opts.repId ?? null, opts.funderId ?? null],
  );
}

export interface BoardSubmission {
  id: string;
  deal_id: string;
  client_id: string;
  funder_id: string;
  funder_name: string;
  sent_on: string;
  status: string;
  decline_reason: string | null;
  decline_note: string;
  note: string;
  status_changed_at: string;
  responded_on: string | null;
  chase_count: number;
  last_chased_on: string | null;
  approval_expires_on: string | null;
  source: string;
}

/** Every lender row on the listed deals, one query, for the board's per-lender chips. */
export async function listBoardSubmissions(
  q: Db,
  dealIds: readonly string[],
): Promise<BoardSubmission[]> {
  if (dealIds.length === 0) return [];
  return json<BoardSubmission>(
    q,
    `select to_jsonb(x) as j from (
       select s.id, s.deal_id, s.client_id, s.funder_id, fu.name as funder_name, s.sent_on::text as sent_on, s.status,
              s.decline_reason, s.decline_note, s.note, s.status_changed_at, s.responded_at::date::text as responded_on,
              s.chase_count, s.last_chased_at::date::text as last_chased_on, s.approval_expires_on::text as approval_expires_on, s.source
         from submissions s join funders fu on fu.id = s.funder_id
        where s.deal_id = any($1::uuid[]) order by s.sent_on, s.created_at
     ) x`,
    [dealIds],
  );
}

/** The people and lenders the board can filter by. */
export async function boardFilters(
  q: Db,
): Promise<{ reps: { id: string; name: string }[]; lenders: { id: string; name: string }[] }> {
  const reps = await q.query<{ id: string; name: string }>(
    "select id, coalesce(nullif(name, ''), email) as name from app_users where active and role in ('rep', 'manager') order by name",
  );
  const lenders = await q.query<{ id: string; name: string }>(
    "select id, name from funders where active order by name",
  );
  return { reps: reps.rows, lenders: lenders.rows };
}

export async function getDeal(q: Db, dealId: string): Promise<DealCard | null> {
  const rows = await json<DealCard>(q, `${CARD_SELECT} and d.id = $1`, [dealId]);
  return rows[0] ?? null;
}

/** The merchant's open deal, if any. */
export async function openDealFor(q: Db, clientId: string): Promise<DealRow | null> {
  const rows = await json<DealRow>(
    q,
    `select to_jsonb(d) || jsonb_build_object('status', app.deal_status(d)) as j
       from deals d where d.client_id = $1 and d.outcome = 'open' order by d.created_at desc limit 1`,
    [clientId],
  );
  return rows[0] ?? null;
}

/** Every deal a merchant ever had, newest first. */
export async function listClientDeals(q: Db, clientId: string): Promise<DealCard[]> {
  return json<DealCard>(q, `${CARD_SELECT} and d.client_id = $1 order by d.created_at desc`, [
    clientId,
  ]);
}

/** Counts per status for the filter chips, in one query. */
export async function dealStatusCounts(q: Db): Promise<Record<string, number>> {
  const { rows } = await q.query<{ status: string; n: number }>(
    `select app.deal_status(d) as status, count(*)::int as n
       from deals d
      where not exists (select 1 from trashed_clients tc where tc.client_id = d.client_id)
      group by 1`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
