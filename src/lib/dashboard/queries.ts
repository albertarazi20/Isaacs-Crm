/**
 * Dashboard loaders. Every query runs under row-level security, so the same code gives a rep their own numbers and a
 * manager the shop's. Months are 'YYYY-MM'.
 */
import type { Db } from "../db";
import type { ISODate } from "../mca/dates";
import { type MeterTone, meterTone, type NowItem, rankNow } from "./metrics";

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
}

export async function monthScoreboard(q: Db, month: string): Promise<Scoreboard> {
  const m = assertMonth(month);
  const { rows } = await q.query<Scoreboard>(
    `with live as (select c.id from clients c where not exists (select 1 from trashed_clients tc where tc.client_id = c.id))
     select $1::text as month,
       (select count(*)::int from clients c join live on live.id = c.id where to_char(c.created_at, 'YYYY-MM') = $1) as new_leads,
       (select count(*)::int from clients c join live on live.id = c.id where to_char(c.application_received_on, 'YYYY-MM') = $1) as apps_in`,
    [m],
  );
  const r = rows[0];
  if (!r) throw new Error("scoreboard query returned nothing");
  return r;
}

// ---------- rep scorecard (one row for a rep, everyone for a manager) ----------

export interface RepScore {
  user_id: string;
  name: string;
  email: string;
  role: string;
  new_leads: number;
  overdue: number;
  /** Median hours from a lead landing to the rep's first call, this month. Null without calls. */
  speed_to_lead_hours: number | null;
}

export async function repScorecard(q: Db, month: string, today: ISODate): Promise<RepScore[]> {
  const m = assertMonth(month);
  return json<RepScore>(
    q,
    `select to_jsonb(x) as j from (
       select u.id as user_id, u.name, u.email, u.role,
         (select count(*)::int from clients c where c.user_id = u.id and to_char(c.created_at, 'YYYY-MM') = $1
            and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)) as new_leads,
         (select count(*)::int from timers t join clients c on c.id = t.client_id where t.user_id = u.id and t.done_at is null and t.due_on < $2::date
            and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)) as overdue,
         (select round(percentile_cont(0.5) within group (order by extract(epoch from (a.first_call - c.created_at)) / 3600)::numeric, 1)
            from clients c
            join lateral (select min(a.occurred_at) as first_call from activities a where a.client_id = c.id and a.kind = 'call') a on true
           where c.user_id = u.id and to_char(c.created_at, 'YYYY-MM') = $1 and a.first_call is not null) as speed_to_lead_hours
         from app_users u
        where u.active and u.role in ('rep', 'manager')
          and (app.can_see_all() or u.id = app.current_user_id())
        order by new_leads desc, u.name
     ) x`,
    [m, today],
  );
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

type Raw = Omit<NowItem, "score" | "href">;

/**
 * Everything that wants a human in the next hour, ranked by `rankNow`: a merchant who wrote back and has not been
 * answered, and follow-ups past due. A rep gets their own merchants (RLS); a manager gets everyone's.
 */
export async function nowItems(
  q: Db,
  today: ISODate,
  opts: { limit?: number } = {},
): Promise<NowItem[]> {
  const items: Omit<NowItem, "score">[] = [];
  const push = (kind: NowItem["kind"], rows: Raw[]) => {
    for (const r of rows)
      items.push({ ...r, kind, cents: Number(r.cents), href: `/clients/${r.client_id}` });
  };

  // 1. merchant replied and nobody has answered (the merchant row's flag)
  push(
    "merchant_replied",
    await json<Raw>(
      q,
      `select to_jsonb(x) as j from (
         select c.id as client_id, c.business_name,
                'Answer ' || coalesce(nullif(c.contact_name, ''), c.business_name) as label,
                coalesce(nullif(c.reply_waiting_subject, ''), 'The merchant wrote back') as detail,
                coalesce(k.wanted_amount_cents, 0)::bigint as cents,
                extract(day from now() - c.reply_waiting_since)::int as age_days
           from clients c
           left join lateral (select wanted_amount_cents from client_asks k where k.client_id = c.id order by k.created_at desc limit 1) k on true
          where c.reply_waiting_since is not null
            and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
       ) x`,
    ),
  );

  // 2. overdue follow-ups
  push(
    "overdue",
    await json<Raw>(
      q,
      `select to_jsonb(x) as j from (
         select distinct on (t.client_id) t.client_id, c.business_name,
                case t.kind when 'scheduled_call' then 'Call back' else 'Follow up' end as label,
                case when t.note <> '' then t.note else 'Due ' || to_char(t.due_on, 'Mon DD') end as detail,
                coalesce(k.wanted_amount_cents, 0) as cents, ($1::date - t.due_on)::int as age_days
           from timers t join clients c on c.id = t.client_id
           left join lateral (select wanted_amount_cents from client_asks k where k.client_id = c.id order by k.created_at desc limit 1) k on true
          where t.done_at is null and t.due_on < $1::date
            and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
          order by t.client_id, t.due_on
       ) x`,
      [today],
    ),
  );

  const ranked = rankNow(items);
  return opts.limit ? ranked.slice(0, opts.limit) : ranked;
}
