import type { Db } from "../db";
import { ALL_MEMBERS_MAX } from "../followup/limits";
import type { StipKind } from "../mca/stips";

export interface BucketRow {
  id: string;
  key: string | null;
  name: string;
  owner_id: string | null;
  rule: string | null;
  sort: number;
  active: boolean;
  /** Live enrolments right now. */
  members: number;
  steps: number;
  /** Set: the bucket sends this template to every member once a day instead of running its steps (0593). */
  daily_template_id: string | null;
  daily_template_name: string | null;
  /** The shop's reminder time, minutes after the merchant's local midnight (shop_settings.daily_reminder_minute). */
  daily_reminder_minute: number;
}

/** Shared buckets plus the caller's own, in the order the Follow Up page shows them. RLS hides other reps' buckets. */
export async function listBuckets(q: Db, includeInactive = false): Promise<BucketRow[]> {
  const { rows } = await q.query<BucketRow>(
    `select b.id, b.key, b.name, b.owner_id, b.rule, b.sort, b.active,
            (select count(*)::int from enrollments e where e.bucket_id = b.id and e.stopped_at is null) as members,
            (select count(*)::int from bucket_steps s where s.bucket_id = b.id) as steps,
            b.daily_template_id, (select t.name from templates t where t.id = b.daily_template_id) as daily_template_name,
            (select daily_reminder_minute from shop_settings) as daily_reminder_minute
       from buckets b
      where (b.active or $1)
      order by b.sort, b.name`,
    [includeInactive],
  );
  return rows;
}

export interface BucketMember {
  enrollment_id: string;
  client_id: string;
  business_name: string;
  contact_name: string;
  phone: string;
  email: string;
  state: string;
  timezone: string;
  /** "ET", "CT", "MT", "AZ" (Arizona keeps MST all year), "PT", "AKT", "HT", or the IANA zone when it is none of those. */
  tz_label: string;
  wanted_amount_cents: number | null;
  entered_at: string;
  next_step: number;
  next_due_on: string | null;
  steps_sent: number;
  paused: boolean;
  last_touch_at: string | null;
  reply_waiting: boolean;
  email_opt_out: boolean;
  email_bounced: boolean;
  stips_missing: number;
  /** The required checklist items not yet in, for the {missing_docs} merge field. */
  missing: { kind: StipKind; period: string | null }[];
  /** The merchant's own last move: a reply, an open, a document they sent, a signature (see CardMeta.active_at). */
  active_at: string | null;
  rep_name: string;
  /** ok, no_text, no_call, no_email or dnc: what the merchant has asked us not to do (0002). */
  contact_status: string;
  bucket_id: string;
  bucket_name: string;
}

// every zone app_state_tz can return gets a short label: Michigan and Indiana are ET, Idaho is MT (db 0310)
const TZ_LABEL = `case app.client_timezone(c)
  when 'America/New_York' then 'ET' when 'America/Detroit' then 'ET' when 'America/Indiana/Indianapolis' then 'ET'
  when 'America/Chicago' then 'CT' when 'America/Denver' then 'MT' when 'America/Boise' then 'MT'
  when 'America/Phoenix' then 'AZ' when 'America/Los_Angeles' then 'PT' when 'America/Anchorage' then 'AKT'
  when 'Pacific/Honolulu' then 'HT' else app.client_timezone(c) end`;

const MEMBER_SELECT = `select e.id as enrollment_id, c.id as client_id, c.business_name, c.contact_name, c.phone, c.email, c.state,
              app.client_timezone(c) as timezone, ${TZ_LABEL} as tz_label,
              (select k.wanted_amount_cents from client_asks k where k.client_id = c.id order by k.created_at desc limit 1) as wanted_amount_cents,
              e.entered_at, e.next_step, e.next_due_on::text as next_due_on, e.steps_sent, e.paused,
              (select max(a.occurred_at) from activities a
                where a.client_id = c.id and a.kind in ('call', 'text', 'email')
                  and not (a.kind = 'email' and a.body like 'Merchant replied%')) as last_touch_at,
              c.reply_waiting_since is not null as reply_waiting, c.email_opt_out, c.email_bounced_at is not null as email_bounced,
              (select count(*)::int from stips s where s.client_id = c.id and s.required and s.received_at is null) as stips_missing,
              coalesce((select jsonb_agg(jsonb_build_object('kind', s.kind, 'period', s.period::text) order by s.kind, s.period)
                          from stips s where s.client_id = c.id and s.required and s.received_at is null), '[]'::jsonb) as missing,
              greatest(
                (select max(ie.received_at) from inbound_emails ie where ie.client_id = c.id),
              (select max(a.occurred_at) from activities a
                where a.client_id = c.id and a.kind = 'email' and a.body like 'Merchant replied%'),
                (select max(lo.opened_at) from link_opens lo where lo.client_id = c.id),
                (select max(d.created_at) from documents d
                  where d.client_id = c.id and d.deleted_at is null and d.source in ('upload_link', 'email')),
                (select max(ap.signed_at) from applications ap where ap.client_id = c.id)
              ) as active_at,
              u.name as rep_name, c.contact_status, b.id as bucket_id, b.name as bucket_name
         from enrollments e join clients c on c.id = e.client_id join app_users u on u.id = c.user_id
         join buckets b on b.id = e.bucket_id`;

const toMember = (j: BucketMember): BucketMember => ({
  ...j,
  wanted_amount_cents: j.wanted_amount_cents === null ? null : Number(j.wanted_amount_cents),
});

/** The lead lines in one bucket, live enrolments only, soonest step first. */
export async function listBucketMembers(q: Db, bucketId: string): Promise<BucketMember[]> {
  const { rows } = await q.query<{ j: BucketMember }>(
    `select to_jsonb(x) as j from (
       ${MEMBER_SELECT}
        where e.bucket_id = $1 and e.stopped_at is null
          and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
        order by e.paused, e.next_due_on nulls last, c.business_name
     ) x`,
    [bucketId],
  );
  return rows.map((r) => toMember(r.j));
}

export { ALL_MEMBERS_MAX };

/**
 * Everyone in any bucket, as the signed-in person may see them: a merchant is in one bucket at a time. Stops at
 * ALL_MEMBERS_MAX and says so (`truncated`), because a search or an export that quietly leaves people out reads as
 * complete: reads one extra row to know whether there were more.
 */
export async function listAllMembersCapped(
  q: Db,
): Promise<{ members: BucketMember[]; truncated: boolean }> {
  const { rows } = await q.query<{ j: BucketMember }>(
    `select to_jsonb(x) as j from (
       ${MEMBER_SELECT}
        where e.stopped_at is null
          and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
        order by b.sort, lower(b.name), e.paused, e.next_due_on nulls last, c.business_name
        limit ${ALL_MEMBERS_MAX + 1}
     ) x`,
  );
  return {
    members: rows.slice(0, ALL_MEMBERS_MAX).map((r) => toMember(r.j)),
    truncated: rows.length > ALL_MEMBERS_MAX,
  };
}

export async function listAllMembers(q: Db): Promise<BucketMember[]> {
  return (await listAllMembersCapped(q)).members;
}

export interface TemplateRow {
  id: string;
  owner_id: string | null;
  name: string;
  channel: string;
  subject: string;
  body: string;
  approved: boolean;
  archived: boolean;
  created_by_name: string | null;
  updated_at: string;
  /** Buckets whose steps use it. */
  used_in: string[];
}

export async function listTemplates(q: Db, includeArchived = false): Promise<TemplateRow[]> {
  const { rows } = await q.query<{ j: TemplateRow }>(
    `select to_jsonb(x) as j from (
       select t.id, t.owner_id, t.name, t.channel, t.subject, t.body, t.approved, t.archived, u.name as created_by_name, t.updated_at,
              coalesce((select array_agg(distinct b.name order by b.name) from bucket_steps s join buckets b on b.id = s.bucket_id where s.template_id = t.id), '{}') as used_in
         from templates t left join app_users u on u.id = t.created_by
        where (not t.archived or $1) and t.channel = 'email'
        order by t.owner_id nulls first, t.name
     ) x`,
    [includeArchived],
  );
  return rows.map((r) => r.j);
}

export interface BucketStepRow {
  id: string;
  step_no: number;
  day_offset: number;
  template_id: string | null;
  template_name: string | null;
  template_approved: boolean | null;
  action: string;
}

export async function listBucketSteps(q: Db, bucketId: string): Promise<BucketStepRow[]> {
  const { rows } = await q.query<BucketStepRow>(
    `select s.id, s.step_no, s.day_offset, s.template_id, t.name as template_name, t.approved as template_approved, s.action
       from bucket_steps s left join templates t on t.id = s.template_id
      where s.bucket_id = $1 order by s.step_no`,
    [bucketId],
  );
  return rows;
}

/**
 * Scores (plan §5.13, S1-7): what each template and each bucket actually does. Counted from the outbox rows that
 * went out in the window; a reply, a document or an unsubscribe within 14 days of a send is credited to it.
 * Rates are fractions (0.1 = 10%). Row security scopes the rows: a rep scores their own sends, a manager the shop's.
 */
export interface ScoreRow {
  sent: number;
  replies: number;
  docs_in: number;
  /** Average days from the send to the merchant's first document, over the sends that got one. */
  avg_days_to_docs: number | null;
  bounces: number;
  unsubscribes: number;
  reply_rate: number;
  docs_rate: number;
  bounce_rate: number;
  unsubscribe_rate: number;
}
export interface TemplateScore extends ScoreRow {
  template_id: string;
  name: string;
  auto_paused_at: string | null;
  auto_pause_reason: string;
}
export interface BucketScore extends ScoreRow {
  bucket_id: string;
  name: string;
  /** Live enrolments right now. */
  members: number;
}

const ATTRIBUTION = "interval '14 days'";
const SENDS_SQL = `
  select o.id, o.template_id, o.source, o.client_id, o.sent_at, o.delivery_status,
         exists (select 1 from inbound_emails i where i.client_id = o.client_id and i.kind = 'merchant'
                    and i.received_at > o.sent_at and i.received_at < o.sent_at + ${ATTRIBUTION}) as replied,
         (select min(d.created_at) from documents d where d.client_id = o.client_id and d.deleted_at is null
            and d.created_at > o.sent_at and d.created_at < o.sent_at + ${ATTRIBUTION}) as first_doc_at,
         exists (select 1 from suppressions sp where sp.client_id = o.client_id
                    and sp.reason in ('unsubscribe', 'stop_reply', 'complaint')
                    and sp.created_at > o.sent_at and sp.created_at < o.sent_at + ${ATTRIBUTION}) as unsubscribed
    from outbox o
   where o.status = 'sent' and o.lane in ('sequence', 'blast') and o.sent_at > now() - make_interval(days => $1)`;
const TOTALS_SQL = `
  count(s.id)::int as sent,
  count(*) filter (where s.replied)::int as replies,
  count(*) filter (where s.first_doc_at is not null)::int as docs_in,
  round((avg(extract(epoch from (s.first_doc_at - s.sent_at)) / 86400))::numeric, 1)::float as avg_days_to_docs,
  count(*) filter (where s.delivery_status = 'bounced')::int as bounces,
  count(*) filter (where s.unsubscribed)::int as unsubscribes`;

const withRates = <T extends ScoreRow>(r: T): T => {
  const rate = (n: number) => (r.sent > 0 ? Math.round((n / r.sent) * 1000) / 1000 : 0);
  return {
    ...r,
    reply_rate: rate(r.replies),
    docs_rate: rate(r.docs_in),
    bounce_rate: rate(r.bounces),
    unsubscribe_rate: rate(r.unsubscribes),
  };
};

export async function templateScores(q: Db, days = 90): Promise<TemplateScore[]> {
  const { rows } = await q.query<TemplateScore>(
    `with s as (${SENDS_SQL})
     select t.id as template_id, t.name, t.auto_paused_at, t.auto_pause_reason, ${TOTALS_SQL}
       from templates t left join s on s.template_id = t.id
      where not t.archived and t.channel = 'email'
      group by t.id order by sent desc, t.name`,
    [days],
  );
  return rows.map(withRates);
}

export async function bucketScores(q: Db, days = 90): Promise<BucketScore[]> {
  const { rows } = await q.query<BucketScore>(
    `with s as (${SENDS_SQL})
     select b.id as bucket_id, b.name,
            (select count(*)::int from enrollments e where e.bucket_id = b.id and e.stopped_at is null) as members,
            ${TOTALS_SQL}
       from buckets b left join s on s.source like 'bucket:' || b.id::text || ':%'
      where b.active
      group by b.id order by b.sort, b.name`,
    [days],
  );
  return rows.map(withRates);
}
