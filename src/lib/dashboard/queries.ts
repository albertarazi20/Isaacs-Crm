/**
 * Dashboard loaders. Every query runs under row-level security, so the same code gives a rep their own numbers and a
 * manager the shop's. Months are 'YYYY-MM'.
 */
import type { Db } from "../db";
import { KICKBACK_LABELS, type KickbackReason } from "../deals/types";
import { funderScoreboard, listFunders } from "../funders/queries";
import type { ScoreRow } from "../funders/scoreboard";
import type { ISODate } from "../mca/dates";
import {
  type FunnelCounts,
  type MeterTone,
  meterTone,
  type NowItem,
  type NowKind,
  rankNow,
} from "./metrics";

const json = async <T>(q: Db, sql: string, params: unknown[] = []): Promise<T[]> =>
  (await q.query<{ j: T }>(sql, params)).rows.map((r) => r.j);

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export function monthOf(day: ISODate): string {
  return day.slice(0, 7);
}
function assertMonth(month: string): string {
  if (!MONTH.test(month)) throw new Error(`bad month: ${month}`);
  return month;
}

// ---------- the month scoreboard ----------

export interface Scoreboard {
  month: string;
  new_leads: number;
  apps_in: number;
  submitted: number;
  approved: number;
  offers_in: number;
  funded_count: number;
  funded_cents: number;
  commission_cents: number;
  rep_cut_cents: number;
  avg_points: number | null;
  avg_deal_cents: number | null;
}

export async function monthScoreboard(q: Db, month: string): Promise<Scoreboard> {
  const m = assertMonth(month);
  const { rows } = await q.query<Scoreboard>(
    `with live as (select c.id from clients c where not exists (select 1 from trashed_clients tc where tc.client_id = c.id))
     select $1::text as month,
       (select count(*)::int from clients c join live on live.id = c.id where to_char(c.created_at, 'YYYY-MM') = $1) as new_leads,
       (select count(*)::int from clients c join live on live.id = c.id where to_char(c.application_received_on, 'YYYY-MM') = $1) as apps_in,
       (select count(*)::int from deals d join live on live.id = d.client_id where to_char(d.sent_at, 'YYYY-MM') = $1) as submitted,
       (select count(*)::int from submissions s join live on live.id = s.client_id where s.status = 'approved' and to_char(s.status_changed_at, 'YYYY-MM') = $1) as approved,
       (select count(*)::int from offers o join live on live.id = o.client_id where to_char(o.received_on, 'YYYY-MM') = $1) as offers_in,
       (select count(*)::int from fundings f join live on live.id = f.client_id where f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1) as funded_count,
       (select coalesce(sum(f.amount_cents), 0)::bigint from fundings f join live on live.id = f.client_id where f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1) as funded_cents,
       (select coalesce(sum(f.commission_cents), 0)::bigint from fundings f join live on live.id = f.client_id where f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1) as commission_cents,
       (select coalesce(sum(f.rep_cut_cents), 0)::bigint from fundings f join live on live.id = f.client_id where f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1) as rep_cut_cents,
       (select round(avg(app.points_of(f)), 2) from fundings f join live on live.id = f.client_id where f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1) as avg_points,
       (select round(avg(f.amount_cents))::bigint from fundings f join live on live.id = f.client_id where f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1) as avg_deal_cents`,
    [m],
  );
  const r = rows[0];
  if (!r) throw new Error("scoreboard query returned nothing");
  return {
    ...r,
    funded_cents: Number(r.funded_cents),
    commission_cents: Number(r.commission_cents),
    rep_cut_cents: Number(r.rep_cut_cents),
    avg_points: r.avg_points === null ? null : Number(r.avg_points),
    avg_deal_cents: r.avg_deal_cents === null ? null : Number(r.avg_deal_cents),
  };
}

export async function funnelCounts(q: Db, month: string): Promise<FunnelCounts> {
  const s = await monthScoreboard(q, month);
  return {
    leads: s.new_leads,
    apps_in: s.apps_in,
    submitted: s.submitted,
    approved: s.approved,
    funded: s.funded_count,
  };
}

// ---------- money on the table ----------

export interface ApprovedUnfunded {
  client_id: string;
  deal_id: string | null;
  business_name: string;
  funder_name: string;
  amount_cents: number;
  factor_rate: number;
  received_on: ISODate;
  days: number;
  offer_status: "open" | "presented";
}

export interface RenewalReady {
  client_id: string;
  funding_id: string;
  business_name: string;
  funder_name: string;
  amount_cents: number;
  renewal_eligible_on: ISODate;
  paid_pct: number;
}

export interface MoneyOnTable {
  approved_unfunded: ApprovedUnfunded[];
  approved_unfunded_cents: number;
  /** Confirmed fundings whose commission the lender has not paid yet (expected, or inside the clawback window). */
  expected_commission_cents: number;
  renewals_ready: RenewalReady[];
  renewals_ready_cents: number;
}

export async function moneyOnTable(q: Db, today: ISODate): Promise<MoneyOnTable> {
  // The best live offer per merchant whose deal is still open: approved money nobody has closed.
  const approved = await json<ApprovedUnfunded>(
    q,
    `select to_jsonb(x) as j from (
       select distinct on (o.client_id)
              o.client_id, d.id as deal_id, c.business_name, fu.name as funder_name, o.amount_cents, o.factor_rate,
              o.received_on::text as received_on, ($1::date - o.received_on)::int as days, o.status as offer_status
         from offers o
         join clients c on c.id = o.client_id
         join submissions s on s.id = o.submission_id
         join funders fu on fu.id = s.funder_id
         left join lateral (select d.id from deals d where d.client_id = o.client_id and d.outcome = 'open'
                            order by d.created_at desc limit 1) d on true
        where o.status in ('open', 'presented')
          and not exists (select 1 from trashed_clients tc where tc.client_id = o.client_id)
          and not exists (select 1 from fundings f where f.client_id = o.client_id and f.funded_on >= o.received_on)
        order by o.client_id, o.amount_cents desc, o.received_on desc
     ) x order by x.amount_cents desc`,
    [today],
  );
  const { rows: exp } = await q.query<{ cents: string }>(
    `select coalesce(sum(f.commission_cents), 0)::text as cents from fundings f
      where f.confirmed_at is not null and f.ledger_state in ('expected', 'at_risk')
        and not exists (select 1 from trashed_clients tc where tc.client_id = f.client_id)`,
  );
  const renewals = await json<RenewalReady>(
    q,
    `select to_jsonb(x) as j from (
       select f.client_id, f.id as funding_id, c.business_name, f.funder_name, f.amount_cents,
              f.renewal_eligible_on::text as renewal_eligible_on,
              case when f.payback_cents > 0 then least(100, round(100.0 * coalesce(f.paid_back_override_cents,
                greatest(0, least(f.payback_cents, f.payment_cents * app.remittances_elapsed(f.funded_on, $1::date, f.frequency)))) / f.payback_cents, 1)) else 0 end as paid_pct
         from fundings f join clients c on c.id = f.client_id
        where f.status = 'active' and f.renewal_eligible_on is not null and f.renewal_eligible_on <= $1::date
          and not exists (select 1 from trashed_clients tc where tc.client_id = f.client_id)
        order by f.renewal_eligible_on
     ) x`,
    [today],
  );
  return {
    approved_unfunded: approved,
    approved_unfunded_cents: approved.reduce((n, a) => n + Number(a.amount_cents), 0),
    expected_commission_cents: Number(exp[0]?.cents ?? 0),
    renewals_ready: renewals,
    renewals_ready_cents: renewals.reduce((n, r) => n + Number(r.amount_cents), 0),
  };
}

// ---------- rep scorecard (one row for a rep, everyone for a manager) ----------

export interface RepScore {
  user_id: string;
  name: string;
  email: string;
  role: string;
  new_leads: number;
  submitted: number;
  approved: number;
  funded_count: number;
  funded_cents: number;
  commission_cents: number;
  overdue: number;
  /** Median hours from a lead landing to the rep's first call, this month. Null without calls. */
  speed_to_lead_hours: number | null;
  /** Speed numbers (plan §3.6; audit S3-12), medians in days over this month's deals. Null without data. */
  lead_to_sub_days: number | null;
  sub_to_offer_days: number | null;
  approval_to_funded_days: number | null;
  /** Files ops kicked back, of the files submitted to ops this month. */
  kickbacks: number;
  submitted_to_ops: number;
  kickback_rate_pct: number | null;
}

export async function repScorecard(q: Db, month: string, today: ISODate): Promise<RepScore[]> {
  const m = assertMonth(month);
  const rows = await json<Omit<RepScore, "kickback_rate_pct">>(
    q,
    `select to_jsonb(x) as j from (
       select u.id as user_id, u.name, u.email, u.role,
         (select count(*)::int from clients c where c.user_id = u.id and to_char(c.created_at, 'YYYY-MM') = $1
            and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)) as new_leads,
         (select count(*)::int from deals d where d.user_id = u.id and to_char(d.sent_at, 'YYYY-MM') = $1) as submitted,
         (select count(*)::int from submissions s where s.user_id = u.id and s.status = 'approved' and to_char(s.status_changed_at, 'YYYY-MM') = $1) as approved,
         (select count(*)::int from fundings f where f.user_id = u.id and f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1) as funded_count,
         (select coalesce(sum(f.amount_cents), 0)::bigint from fundings f where f.user_id = u.id and f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1) as funded_cents,
         (select coalesce(sum(f.commission_cents), 0)::bigint from fundings f where f.user_id = u.id and f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1) as commission_cents,
         (select count(*)::int from timers t join clients c on c.id = t.client_id where t.user_id = u.id and t.done_at is null and t.due_on < $2::date
            and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)) as overdue,
         (select round(percentile_cont(0.5) within group (order by extract(epoch from (a.first_call - c.created_at)) / 3600)::numeric, 1)
            from clients c
            join lateral (select min(a.occurred_at) as first_call from activities a where a.client_id = c.id and a.kind = 'call') a on true
           where c.user_id = u.id and to_char(c.created_at, 'YYYY-MM') = $1 and a.first_call is not null) as speed_to_lead_hours,
         -- lead landed → file sent to lenders, for deals sent this month
         (select round(percentile_cont(0.5) within group (order by extract(epoch from (d.sent_at - c.created_at)) / 86400)::numeric, 1)
            from deals d join clients c on c.id = d.client_id
           where d.user_id = u.id and d.sent_at is not null and to_char(d.sent_at, 'YYYY-MM') = $1) as lead_to_sub_days,
         -- sent to lenders → the first offer in, for deals whose first offer came this month
         (select round(percentile_cont(0.5) within group (order by (o.first_offer - d.sent_at::date))::numeric, 1)
            from deals d join lateral (select min(o.received_on) as first_offer from offers o where o.deal_id = d.id) o on true
           where d.user_id = u.id and d.sent_at is not null and o.first_offer is not null and to_char(o.first_offer, 'YYYY-MM') = $1) as sub_to_offer_days,
         -- first approval → funded, for fundings confirmed this month
         (select round(percentile_cont(0.5) within group (order by (f.funded_on - a.approved_on))::numeric, 1)
            from fundings f join lateral (select min(coalesce(s.responded_at, s.status_changed_at))::date as approved_on from submissions s
                                            where s.deal_id = f.deal_id and s.status in ('approved', 'revised', 'contracts_out', 'contracts_in', 'funding_call', 'funded')) a on true
           where f.user_id = u.id and f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1 and a.approved_on is not null) as approval_to_funded_days,
         (select count(*)::int from deals d where d.user_id = u.id and to_char(d.queued_at, 'YYYY-MM') = $1 and d.kickback_count > 0) as kickbacks,
         (select count(*)::int from deals d where d.user_id = u.id and to_char(d.queued_at, 'YYYY-MM') = $1) as submitted_to_ops
         from app_users u
        where u.active and u.role in ('rep', 'manager')
          and (app.can_see_all() or u.id = app.current_user_id())
        order by funded_cents desc, u.name
     ) x`,
    [m, today],
  );
  return rows.map((r) => ({
    ...r,
    lead_to_sub_days: r.lead_to_sub_days === null ? null : Number(r.lead_to_sub_days),
    sub_to_offer_days: r.sub_to_offer_days === null ? null : Number(r.sub_to_offer_days),
    approval_to_funded_days:
      r.approval_to_funded_days === null ? null : Number(r.approval_to_funded_days),
    kickback_rate_pct:
      r.submitted_to_ops > 0 ? Math.round((100 * r.kickbacks) / r.submitted_to_ops) : null,
  }));
}

// ---------- lender scorecard ----------

export interface LenderScore extends ScoreRow {
  name: string;
}

export async function lenderScorecard(q: Db): Promise<LenderScore[]> {
  const funders = await listFunders(q);
  const board = await funderScoreboard(
    q,
    funders.map((f) => f.id),
  );
  return funders
    .map((f) => ({ name: f.name, ...(board[f.id] as ScoreRow) }))
    .filter((r) => r.submissions > 0)
    .sort((a, b) => b.approvals - a.approvals || b.submissions - a.submissions);
}

// ---------- email meter ----------

export interface EmailMeter {
  mailbox_id: string;
  address: string;
  kind: "gmail" | "resend";
  owner_name: string | null;
  sent_24h: number;
  cap: number;
  amber_at: number;
  reserved_for_intake: number;
  tone: MeterTone;
}

export async function emailMeters(q: Db): Promise<EmailMeter[]> {
  const rows = await json<Omit<EmailMeter, "tone">>(
    q,
    `select to_jsonb(x) as j from (
       select m.id as mailbox_id, m.address, m.kind, u.name as owner_name,
              app.mailbox_sent_24h(m.id) as sent_24h,
              least(s.daily_cap, m.provider_limit) as cap,
              least(s.amber_at, m.provider_limit) as amber_at,
              s.reserved_for_intake
         from mailboxes m cross join shop_settings s
         left join app_users u on u.id = m.user_id
        where m.active
        order by m.kind desc, u.name nulls first
     ) x`,
  );
  return rows.map((r) => ({ ...r, tone: meterTone(r.sent_24h, r.cap, r.amber_at) }));
}

// ---------- "do this now" ----------

type Raw = Omit<NowItem, "score">;

/**
 * Everything that wants a human in the next hour, from eight sources, ranked by `rankNow`. A rep gets their own
 * merchants (RLS); a manager also gets the AI's proposed updates waiting for a decision.
 */
export async function nowItems(
  q: Db,
  today: ISODate,
  opts: { manager: boolean; limit?: number },
): Promise<NowItem[]> {
  const items: Raw[] = [];
  const push = (kind: NowKind, rows: Omit<Raw, "kind" | "href">[]) => {
    for (const r of rows) {
      items.push({
        kind,
        ...r,
        cents: Number(r.cents),
        href: r.deal_id ? `/deals/${r.deal_id}` : `/clients/${r.client_id}`,
      });
    }
  };
  type R = Omit<Raw, "kind" | "href">;

  // 1. merchant replied and nobody has answered: the merchant row's flag (any inbound), plus the reader's event
  push(
    "merchant_replied",
    await json<R>(
      q,
      `select to_jsonb(x) as j from (
         select distinct on (client_id) * from (
           select c.id as client_id, d.id as deal_id, c.business_name,
                  'Answer ' || coalesce(nullif(c.contact_name, ''), c.business_name) as label,
                  coalesce(nullif(c.reply_waiting_subject, ''), 'The merchant wrote back') as detail,
                  coalesce(d.requested_cents, k.wanted_amount_cents, 0)::bigint as cents,
                  extract(day from now() - c.reply_waiting_since)::int as age_days
             from clients c
             left join lateral (select d.id, d.requested_cents from deals d where d.client_id = c.id and d.outcome = 'open' order by d.created_at desc limit 1) d on true
             left join lateral (select wanted_amount_cents from client_asks k where k.client_id = c.id order by k.created_at desc limit 1) k on true
            where c.reply_waiting_since is not null
              and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
           union all
           select d.client_id, d.id as deal_id, c.business_name,
                  'Answer ' || coalesce(nullif(c.contact_name, ''), c.business_name) as label,
                  coalesce(nullif(p.summary, ''), 'The merchant wrote back') as detail,
                  coalesce(d.requested_cents, 0)::bigint as cents,
                  extract(day from now() - p.created_at)::int as age_days
             from proposed_updates p join deals d on d.id = p.deal_id join clients c on c.id = d.client_id
            where p.event = 'merchant_replied' and p.status = 'proposed'
         ) u order by client_id, age_days desc
       ) x`,
    ),
  );

  // 2. AI-proposed updates waiting for a manager's decision
  if (opts.manager) {
    push(
      "decision",
      await json<R>(
        q,
        `select to_jsonb(x) as j from (
           select d.client_id, d.id as deal_id, c.business_name,
                  'Decide: ' || p.event as label, p.summary as detail,
                  coalesce((p.payload->>'amount_cents')::bigint, d.requested_cents, 0) as cents,
                  extract(day from now() - p.created_at)::int as age_days
             from proposed_updates p join deals d on d.id = p.deal_id join clients c on c.id = d.client_id
            where p.status = 'proposed' and p.event <> 'merchant_replied'
         ) x`,
      ),
    );
  }

  // 3. kicked back by ops
  push(
    "kicked_back",
    (
      await json<R & { reason: KickbackReason | null }>(
        q,
        `select to_jsonb(x) as j from (
           select d.client_id, d.id as deal_id, c.business_name, d.kickback_reason as reason,
                  'Fix the file' as label, d.kickback_note as detail, coalesce(d.requested_cents, 0) as cents,
                  extract(day from now() - d.kicked_back_at)::int as age_days
             from deals d join clients c on c.id = d.client_id
            where d.ops_status = 'kicked_back' and d.outcome = 'open'
              and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
         ) x`,
      )
    ).map(({ reason, ...r }) => ({
      ...r,
      label: reason ? `Fix the file: ${KICKBACK_LABELS[reason]}` : "Fix the file: ops sent it back",
    })),
  );

  // 4. offers in, not presented
  push(
    "offer_unpresented",
    await json<R>(
      q,
      `select to_jsonb(x) as j from (
         select distinct on (o.client_id) o.client_id, d.id as deal_id, c.business_name,
                'Present the offer' as label,
                fu.name || ': $' || to_char(o.amount_cents / 100.0, 'FM999,999,990') || ' at ' || o.factor_rate as detail,
                o.amount_cents as cents, ($1::date - o.received_on)::int as age_days
           from offers o join clients c on c.id = o.client_id
           join submissions s on s.id = o.submission_id join funders fu on fu.id = s.funder_id
           left join lateral (select d.id from deals d where d.client_id = o.client_id and d.outcome = 'open' order by d.created_at desc limit 1) d on true
          where o.status = 'open'
            and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
          order by o.client_id, o.amount_cents desc
       ) x`,
      [today],
    ),
  );

  // 5. approved and presented, not funded, cooling off
  push(
    "approval_aging",
    await json<R>(
      q,
      `select to_jsonb(x) as j from (
         select distinct on (o.client_id) o.client_id, d.id as deal_id, c.business_name,
                'Close it: approved ' || ($1::date - o.received_on)::int || ' days ago' as label,
                fu.name || ': $' || to_char(o.amount_cents / 100.0, 'FM999,999,990') || ' at ' || o.factor_rate as detail,
                o.amount_cents as cents, ($1::date - o.received_on)::int as age_days
           from offers o join clients c on c.id = o.client_id
           join submissions s on s.id = o.submission_id join funders fu on fu.id = s.funder_id
           left join lateral (select d.id from deals d where d.client_id = o.client_id and d.outcome = 'open' order by d.created_at desc limit 1) d on true
          where o.status = 'presented' and o.received_on <= $1::date - 2
            and not exists (select 1 from fundings f where f.client_id = o.client_id and f.funded_on >= o.received_on)
            and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
          order by o.client_id, o.amount_cents desc
       ) x`,
      [today],
    ),
  );

  // 6. renewal-ready advances
  push(
    "renewal_ready",
    await json<R>(
      q,
      `select to_jsonb(x) as j from (
         select f.client_id, null::uuid as deal_id, c.business_name,
                'Offer the renewal' as label,
                f.funder_name || ' advance eligible since ' || to_char(f.renewal_eligible_on, 'Mon DD') as detail,
                f.amount_cents as cents, ($1::date - f.renewal_eligible_on)::int as age_days
           from fundings f join clients c on c.id = f.client_id
          where f.status = 'active' and f.renewal_eligible_on is not null and f.renewal_eligible_on <= $1::date
            and not exists (select 1 from deals d where d.client_id = f.client_id and d.kind = 'renewal' and d.outcome = 'open')
            and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
       ) x`,
      [today],
    ),
  );

  // 7. overdue follow-ups
  push(
    "overdue",
    await json<R>(
      q,
      `select to_jsonb(x) as j from (
         select distinct on (t.client_id) t.client_id, d.id as deal_id, c.business_name,
                case t.kind when 'scheduled_call' then 'Call back' when 'renewal' then 'Renewal call' else 'Follow up' end as label,
                case when t.note <> '' then t.note else 'Due ' || to_char(t.due_on, 'Mon DD') end as detail,
                coalesce(k.wanted_amount_cents, 0) as cents, ($1::date - t.due_on)::int as age_days
           from timers t join clients c on c.id = t.client_id
           left join lateral (select wanted_amount_cents from client_asks k where k.client_id = c.id order by k.created_at desc limit 1) k on true
           left join lateral (select d.id from deals d where d.client_id = c.id and d.outcome = 'open' order by d.created_at desc limit 1) d on true
          where t.done_at is null and t.due_on < $1::date
            and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
          order by t.client_id, t.due_on
       ) x`,
      [today],
    ),
  );

  // 8. submissions with no answer for 3+ days
  push(
    "stale_submission",
    await json<R>(
      q,
      `select to_jsonb(x) as j from (
         select s.client_id, d.id as deal_id, c.business_name,
                'Chase ' || fu.name as label,
                'Sent ' || to_char(s.sent_on, 'Mon DD') || ', no answer' as detail,
                coalesce(d.requested_cents, k.wanted_amount_cents, 0) as cents, ($1::date - s.sent_on)::int as age_days
           from submissions s join clients c on c.id = s.client_id join funders fu on fu.id = s.funder_id
           left join lateral (select wanted_amount_cents from client_asks k where k.client_id = c.id order by k.created_at desc limit 1) k on true
           left join lateral (select d.id, d.requested_cents from deals d where d.client_id = c.id and d.outcome = 'open' order by d.created_at desc limit 1) d on true
          where s.status = 'sent' and s.sent_on <= $1::date - 3
            and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
       ) x`,
      [today],
    ),
  );

  const ranked = rankNow(items);
  return opts.limit ? ranked.slice(0, opts.limit) : ranked;
}

// ---------- goals ----------

export interface Goal {
  id: string;
  user_id: string | null;
  month: string; // YYYY-MM
  funded_cents: number;
  deals: number;
}

export async function listGoals(q: Db, month: string): Promise<Goal[]> {
  const m = assertMonth(month);
  const rows = await json<Goal>(
    q,
    `select to_jsonb(x) as j from (
       select g.id, g.user_id, to_char(g.month, 'YYYY-MM') as month, g.funded_cents, g.deals
         from goals g where to_char(g.month, 'YYYY-MM') = $1 order by g.user_id nulls first
     ) x`,
    [m],
  );
  return rows.map((g) => ({ ...g, funded_cents: Number(g.funded_cents) }));
}

/** Upsert one goal line. The RLS policy means only a manager's connection gets past this. */
export async function setGoal(
  q: Db,
  g: { userId: string | null; month: string; fundedCents: number; deals: number },
  setBy: string,
): Promise<void> {
  const m = assertMonth(g.month);
  await q.query(
    `insert into goals (user_id, month, funded_cents, deals, set_by)
     values ($1, ($2 || '-01')::date, $3, $4, $5)
     on conflict (user_id, month) do update set funded_cents = excluded.funded_cents, deals = excluded.deals, set_by = excluded.set_by`,
    [g.userId, m, g.fundedCents, g.deals, setBy],
  );
}
