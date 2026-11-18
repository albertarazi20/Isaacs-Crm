/**
 * The follow-up dashboard's data, in one call (docs/FOLLOW-UP-SYSTEM.md, decision 5): how many merchants are being
 * brought in, what needs a person now, and what just happened. Run it under db.withUser: row security decides whose
 * merchants count, so a rep gets their own book and a manager the shop's. `manager` only switches the per-rep table on.
 *
 * Words used here:
 *   contacted — we reached out: a logged call, or an email we sent (automated or one-to-one);
 *   replied   — the merchant wrote back (the 'Merchant replied' timeline line record_merchant_reply writes);
 *   docs in   — at least one document received;
 *   brought in — handed off (clients.brought_in_at).
 * The month KPIs count merchants by when the thing happened; the funnel follows this month's new leads.
 * Merchants in the trash never count. Months are 'YYYY-MM'; "today" is passed in.
 */
import { type EmailMeter, emailMeters } from "../dashboard/queries";
import type { Db } from "../db";
import type { ISODate } from "../mca/dates";

export interface MonthKpis {
  month: string;
  newLeads: number;
  contacted: number;
  replied: number;
  docsIn: number;
  broughtIn: number;
}
export interface OverviewKpis {
  thisMonth: MonthKpis;
  lastMonth: MonthKpis;
  /** Merchants past their follow-up date, counted as the call list counts them. */
  overdue: number;
  /** Merchants who wrote back and have not been answered. */
  replyWaiting: number;
  /** In the "Ready to hand off" bucket and not handed off yet. */
  readyToHandOff: number;
  /** Median minutes from a lead landing to the first call or sent email, this month's leads. Null when none. */
  speedToLeadMinutes: number | null;
  /** Median days from a lead landing to its hand-off, over the merchants brought in this month. Null when none. */
  daysToBringIn: number | null;
}
export interface WeekPoint {
  /** The Monday the week starts on. */
  weekStart: ISODate;
  newLeads: number;
  broughtIn: number;
}
export type FunnelKey = "leads" | "contacted" | "replied" | "docs_in" | "brought_in";
export interface FunnelStep {
  key: FunnelKey;
  label: string;
  count: number;
}
export interface BucketCount {
  id: string;
  /** System buckets have a key; a rep's own or a shared one has none. */
  key: string | null;
  name: string;
  count: number;
}
export type QueueKind =
  "reply" | "opened" | "call_now" | "ready" | "upload" | "bounced" | "overdue";
export interface QueueItem {
  kind: QueueKind;
  clientId: string;
  businessName: string;
  contactName: string;
  /** One short plain sentence. */
  detail: string;
  /** ISO timestamp of the thing that put it on the list. */
  at: string;
  /** The merchant's rep, when the caller can see other people's merchants; otherwise null. */
  ownerName: string | null;
}
export type ActivityKind =
  "reply" | "upload" | "signed" | "email_sent" | "handed_off" | "lead_added" | "bounced";
export interface ActivityEvent {
  at: string;
  kind: ActivityKind;
  clientId: string;
  businessName: string;
  text: string;
}
export interface RepRow {
  userId: string;
  name: string;
  newLeads: number;
  replied: number;
  docsIn: number;
  broughtIn: number;
  overdue: number;
  speedToLeadMinutes: number | null;
}
export interface Overview {
  month: string;
  today: ISODate;
  kpis: OverviewKpis;
  /** The last 8 weeks, oldest first. */
  series: WeekPoint[];
  /** This month's new leads, and how far they got. */
  funnel: FunnelStep[];
  /** Live enrolments per bucket (system buckets first), without handed-off merchants. */
  buckets: BucketCount[];
  /** "Do this now", at most 25, most urgent first; one line per merchant. */
  queue: QueueItem[];
  /** The latest 14 events. */
  activity: ActivityEvent[];
  /** One row per rep for the month; null unless `manager`. */
  reps: RepRow[] | null;
  email: EmailMeter[];
}

export const QUEUE_MAX = 25;
export const ACTIVITY_MAX = 14;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
function previousMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

// The fixed building blocks every statement below starts from (constants, never input).
const BASE = `
  with live as (
    select c.* from clients c where not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
  ), touch as (
    select a.client_id, a.occurred_at as at from activities a
     where a.kind = 'call' or (a.kind = 'email' and a.body not like 'Merchant replied%')
  ), reply as (
    select a.client_id, a.occurred_at as at from activities a
     where a.kind = 'email' and a.body like 'Merchant replied%'
  ), doc as (
    select d.client_id, d.created_at as at from documents d
     where d.deleted_at is null and d.scan_status not in ('infected', 'rejected')
  )`;

const MONTHS_SQL = `${BASE}
  select m.month,
    (select count(*)::int from live c where to_char(c.created_at, 'YYYY-MM') = m.month) as new_leads,
    (select count(distinct t.client_id)::int from touch t join live c on c.id = t.client_id
      where to_char(t.at, 'YYYY-MM') = m.month) as contacted,
    (select count(distinct r.client_id)::int from reply r join live c on c.id = r.client_id
      where to_char(r.at, 'YYYY-MM') = m.month) as replied,
    (select count(distinct d.client_id)::int from doc d join live c on c.id = d.client_id
      where to_char(d.at, 'YYYY-MM') = m.month) as docs_in,
    (select count(*)::int from live c where to_char(c.brought_in_at, 'YYYY-MM') = m.month) as brought_in
  from (values ($1::text), ($2::text)) m(month)`;

const NOW_SQL = `${BASE}, cohort as (
    select c.* from live c where to_char(c.created_at, 'YYYY-MM') = $1
  )
  select
    -- the call list's own rule: merchants (not timers) past their date, never do-not-contact or handed off, and not
    -- booked for a call today (those are on today's list); the session runs in the person's time zone
    (select count(*)::int from client_cards cc join live c on c.id = cc.id
      where cc.next_due_on < $2::date and cc.contact_status <> 'dnc' and c.brought_in_at is null
        and not (cc.scheduled_call_at is not null and cc.scheduled_call_at::date = $2::date)) as overdue,
    (select count(*)::int from live c where c.reply_waiting_since is not null) as reply_waiting,
    (select count(distinct c.id)::int from live c
       join enrollments e on e.client_id = c.id and e.stopped_at is null
       join buckets b on b.id = e.bucket_id and b.key = 'ready_for_ops'
      where c.brought_in_at is null) as ready,
    (select round((percentile_cont(0.5) within group (
              order by greatest(0, extract(epoch from (f.first_at - c.created_at)) / 60)))::numeric)::int
       from cohort c
       join lateral (select min(t.at) as first_at from touch t where t.client_id = c.id) f on f.first_at is not null
    ) as speed,
    (select round((percentile_cont(0.5) within group (
              order by greatest(0, extract(epoch from (c.brought_in_at - c.created_at)) / 86400)))::numeric, 1)::float
       from live c where to_char(c.brought_in_at, 'YYYY-MM') = $1) as days_to_bring_in,
    (select count(*)::int from cohort) as f_leads,
    (select count(*)::int from cohort c where exists (select 1 from touch t where t.client_id = c.id)) as f_contacted,
    (select count(*)::int from cohort c where exists (select 1 from reply r where r.client_id = c.id)) as f_replied,
    (select count(*)::int from cohort c where exists (select 1 from doc d where d.client_id = c.id)) as f_docs,
    (select count(*)::int from cohort c where c.brought_in_at is not null) as f_brought`;

const SERIES_SQL = `${BASE}
  select w.week_start::text as week_start,
    (select count(*)::int from live c where date_trunc('week', c.created_at)::date = w.week_start) as new_leads,
    (select count(*)::int from live c where date_trunc('week', c.brought_in_at)::date = w.week_start) as brought_in
  from (select date_trunc('week', $1::date::timestamp)::date - 7 * n as week_start from generate_series(0, 7) n) w
  order by w.week_start`;

const BUCKETS_SQL = `
  select b.id, b.key, b.name,
    (select count(*)::int from enrollments e join clients c on c.id = e.client_id
      where e.bucket_id = b.id and e.stopped_at is null and c.brought_in_at is null
        and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)) as count
  from buckets b
  where b.active
  order by (b.key is null), b.sort, lower(b.name)`;

// Seven lists in rank order; each already sorted the way its kind wants (ord ascending).
const QUEUE_SQL = `${BASE}, q as (
    (select 1 as rank, 'reply' as kind, c.id as client_id, c.business_name, c.contact_name, c.user_id,
            coalesce(nullif(btrim(c.reply_waiting_subject), ''), 'The merchant wrote back') as detail,
            c.reply_waiting_since as at, -extract(epoch from c.reply_waiting_since) as ord
       from live c where c.reply_waiting_since is not null
      order by c.reply_waiting_since desc limit 25)
    union all
    -- opened the upload link or the application in the last two days and has not finished: the warmest call there is
    (select 2, 'opened', c.id, c.business_name, c.contact_name, c.user_id,
            case o.kind when 'apply' then 'Opened the application, not signed yet'
                        when 'offer' then 'Opened their offer, not accepted yet'
                        else 'Opened the upload link, nothing sent yet' end,
            o.at, -extract(epoch from o.at)
       from live c
       join lateral (select lo.kind, max(lo.opened_at) as at from link_opens lo
                      where lo.client_id = c.id and lo.opened_at > now() - interval '48 hours'
                      group by lo.kind order by max(lo.opened_at) desc limit 1) o on true
      -- an offer comes after the hand-off as often as before it, and stays on the list while it waits on them
      where (c.brought_in_at is null or o.kind = 'offer') and c.contact_status <> 'dnc'
        and not (o.kind = 'offer' and not exists (select 1 from merchant_offers mo
                                              where mo.client_id = c.id and mo.status = 'sent' and mo.expires_at > now()))
        and not (o.kind = 'apply' and exists (select 1 from applications a
                                               where a.client_id = c.id and a.signed_at >= o.at))
        and not (o.kind = 'upload' and exists (select 1 from documents d
                                                where d.client_id = c.id and d.deleted_at is null and d.created_at >= o.at))
      order by o.at desc limit 25)
    union all
    (select 3, 'call_now', c.id, c.business_name, c.contact_name, c.user_id,
            'New lead' || case when btrim(c.looking_for) <> '' then ' · wants ' || left(btrim(c.looking_for), 60) else '' end,
            c.created_at, -extract(epoch from c.created_at)
       from live c
      where c.brought_in_at is null and c.created_at > now() - interval '24 hours' and c.contact_status <> 'dnc'
        and not exists (select 1 from activities a where a.client_id = c.id and a.kind = 'call')
      order by c.created_at desc limit 25)
    union all
    (select 4, 'ready', c.id, c.business_name, c.contact_name, c.user_id,
            'File complete · ready to hand off', e.entered_at, extract(epoch from e.entered_at)
       from live c
       join enrollments e on e.client_id = c.id and e.stopped_at is null
       join buckets b on b.id = e.bucket_id and b.key = 'ready_for_ops'
      where c.brought_in_at is null
      order by e.entered_at limit 25)
    union all
    (select 5, 'upload', c.id, c.business_name, c.contact_name, c.user_id,
            'Uploaded ' || left(d.filename, 80) || ' · not opened yet', d.at, -extract(epoch from d.at)
       from live c
       join lateral (
         select d.created_at as at, d.filename from documents d
          where d.client_id = c.id and d.deleted_at is null and d.source = 'upload_link'
            and not exists (select 1 from document_views v
                             where v.document_id = d.id and v.viewer_user_id is not null and v.action in ('view', 'download'))
          order by d.created_at desc limit 1) d on true
      where c.brought_in_at is null
      order by d.at desc limit 25)
    union all
    (select 6, 'bounced', c.id, c.business_name, c.contact_name, c.user_id,
            'Email bounced · fix the address', c.email_bounced_at, -extract(epoch from c.email_bounced_at)
       from live c where c.email_bounced_at is not null and c.brought_in_at is null and c.contact_status <> 'dnc'
      order by c.email_bounced_at desc limit 25)
    union all
    -- the same rule as the overdue count above (and the call list): never do-not-contact, not booked for today
    (select 7, 'overdue', c.id, c.business_name, c.contact_name, c.user_id,
            'Follow-up was due ' || to_char(cc.next_due_on, 'FMMon FMDD'), cc.next_due_on::timestamptz,
            extract(epoch from cc.next_due_on::timestamptz)
       from live c join client_cards cc on cc.id = c.id
      where cc.next_due_on < $1::date and cc.contact_status <> 'dnc' and c.brought_in_at is null
        and not (cc.scheduled_call_at is not null and cc.scheduled_call_at::date = $1::date)
      order by cc.next_due_on limit 25)
  )
  select q.kind, q.client_id, q.business_name, q.contact_name, q.detail, q.at,
         case when app.can_see_all() then (select nullif(btrim(u.name), '') from app_users u where u.id = q.user_id) end as owner_name
    from q order by q.rank, q.ord`;

const ACTIVITY_SQL = `${BASE}, ev as (
    (select a.occurred_at as at,
            case when a.kind = 'email' and a.body like 'Merchant replied%' then 'reply'
                 when a.kind = 'email' then 'email_sent'
                 when a.body like 'Handed off%' then 'handed_off'
                 else 'bounced' end as kind,
            a.client_id, c.business_name,
            case when a.kind = 'email' and a.body not like 'Merchant replied%'
                 then 'Email sent: ' || left(split_part(a.body, E'\\n', 1), 120)
                 else left(a.body, 160) end as text
       from activities a join live c on c.id = a.client_id
      where a.kind = 'email' or (a.kind = 'system' and (a.body like 'Handed off%' or a.body like 'Email bounced%'))
      order by a.occurred_at desc limit 14)
    union all
    (select d.created_at, 'upload', d.client_id, c.business_name, 'Uploaded ' || left(d.filename, 120)
       from documents d join live c on c.id = d.client_id
      where d.deleted_at is null and d.source = 'upload_link'
      order by d.created_at desc limit 14)
    union all
    (select ap.signed_at, 'signed', ap.client_id, c.business_name, 'Signed the application'
       from applications ap join live c on c.id = ap.client_id
      order by ap.signed_at desc limit 14)
    union all
    (select c.created_at, 'lead_added', c.id, c.business_name, 'New lead added'
       from live c order by c.created_at desc limit 14)
  )
  select ev.at, ev.kind, ev.client_id, ev.business_name, ev.text from ev order by ev.at desc limit 14`;

const REPS_SQL = `${BASE}
  select u.id as user_id, coalesce(nullif(btrim(u.name), ''), u.email) as name,
    (select count(*)::int from live c where c.user_id = u.id and to_char(c.created_at, 'YYYY-MM') = $1) as new_leads,
    (select count(distinct r.client_id)::int from reply r join live c on c.id = r.client_id
      where c.user_id = u.id and to_char(r.at, 'YYYY-MM') = $1) as replied,
    (select count(distinct d.client_id)::int from doc d join live c on c.id = d.client_id
      where c.user_id = u.id and to_char(d.at, 'YYYY-MM') = $1) as docs_in,
    (select count(*)::int from live c where c.user_id = u.id and to_char(c.brought_in_at, 'YYYY-MM') = $1) as brought_in,
    (select count(*)::int from client_cards cc join live c on c.id = cc.id
      where c.user_id = u.id and cc.next_due_on < $2::date and cc.contact_status <> 'dnc' and c.brought_in_at is null
        and not (cc.scheduled_call_at is not null and cc.scheduled_call_at::date = $2::date)) as overdue,
    (select round((percentile_cont(0.5) within group (
              order by greatest(0, extract(epoch from (f.first_at - c.created_at)) / 60)))::numeric)::int
       from live c
       join lateral (select min(t.at) as first_at from touch t where t.client_id = c.id) f on f.first_at is not null
      where c.user_id = u.id and to_char(c.created_at, 'YYYY-MM') = $1) as speed
  from app_users u
  where u.active and u.role in ('rep', 'manager')
  order by brought_in desc, new_leads desc, name`;

interface MonthRow {
  month: string;
  new_leads: number;
  contacted: number;
  replied: number;
  docs_in: number;
  brought_in: number;
}
const monthKpis = (rows: MonthRow[], month: string): MonthKpis => {
  const r = rows.find((x) => x.month === month);
  return {
    month,
    newLeads: r?.new_leads ?? 0,
    contacted: r?.contacted ?? 0,
    replied: r?.replied ?? 0,
    docsIn: r?.docs_in ?? 0,
    broughtIn: r?.brought_in ?? 0,
  };
};

/** "Do this now": one line per merchant (the most urgent reason wins), as the signed-in person may see them. */
export async function loadQueue(q: Db, today: ISODate): Promise<QueueItem[]> {
  const seen = new Set<string>();
  const queue: QueueItem[] = [];
  const queued = await q.query<{
    kind: QueueKind;
    client_id: string;
    business_name: string;
    contact_name: string;
    detail: string;
    at: Date | string;
    owner_name: string | null;
  }>(QUEUE_SQL, [today]);
  for (const r of queued.rows) {
    if (seen.has(r.client_id) || queue.length >= QUEUE_MAX) continue;
    seen.add(r.client_id);
    queue.push({
      kind: r.kind,
      clientId: r.client_id,
      businessName: r.business_name,
      contactName: r.contact_name,
      detail: r.detail,
      at: iso(r.at),
      ownerName: r.owner_name,
    });
  }
  return queue;
}

export async function loadOverview(
  q: Db,
  args: { today: ISODate; month: string; manager: boolean },
): Promise<Overview> {
  const { today, month, manager } = args;
  if (!MONTH.test(month)) throw new Error(`bad month: ${month}`);
  const last = previousMonth(month);

  const months = (await q.query<MonthRow>(MONTHS_SQL, [month, last])).rows;
  const now = (
    await q.query<{
      overdue: number;
      reply_waiting: number;
      ready: number;
      speed: number | null;
      f_leads: number;
      f_contacted: number;
      f_replied: number;
      f_docs: number;
      f_brought: number;
      days_to_bring_in: number | null;
    }>(NOW_SQL, [month, today])
  ).rows[0];
  if (!now) throw new Error("overview query returned nothing");

  const series = (
    await q.query<{ week_start: string; new_leads: number; brought_in: number }>(SERIES_SQL, [
      today,
    ])
  ).rows.map((r) => ({ weekStart: r.week_start, newLeads: r.new_leads, broughtIn: r.brought_in }));

  const buckets = (await q.query<BucketCount>(BUCKETS_SQL)).rows;

  const queue = await loadQueue(q, today);

  const activity = (
    await q.query<{
      at: Date | string;
      kind: ActivityKind;
      client_id: string;
      business_name: string;
      text: string;
    }>(ACTIVITY_SQL)
  ).rows.map((r) => ({
    at: iso(r.at),
    kind: r.kind,
    clientId: r.client_id,
    businessName: r.business_name,
    text: r.text,
  }));

  const reps = manager
    ? (
        await q.query<{
          user_id: string;
          name: string;
          new_leads: number;
          replied: number;
          docs_in: number;
          brought_in: number;
          overdue: number;
          speed: number | null;
        }>(REPS_SQL, [month, today])
      ).rows.map((r) => ({
        userId: r.user_id,
        name: r.name,
        newLeads: r.new_leads,
        replied: r.replied,
        docsIn: r.docs_in,
        broughtIn: r.brought_in,
        overdue: r.overdue,
        speedToLeadMinutes: r.speed,
      }))
    : null;

  return {
    month,
    today,
    kpis: {
      thisMonth: monthKpis(months, month),
      lastMonth: monthKpis(months, last),
      overdue: now.overdue,
      replyWaiting: now.reply_waiting,
      readyToHandOff: now.ready,
      speedToLeadMinutes: now.speed,
      daysToBringIn: now.days_to_bring_in,
    },
    series,
    funnel: [
      { key: "leads", label: "Leads", count: now.f_leads },
      { key: "contacted", label: "Contacted", count: now.f_contacted },
      { key: "replied", label: "Replied", count: now.f_replied },
      { key: "docs_in", label: "Docs in", count: now.f_docs },
      { key: "brought_in", label: "Brought in", count: now.f_brought },
    ],
    buckets,
    queue,
    activity,
    reps,
    email: await emailMeters(q),
  };
}
