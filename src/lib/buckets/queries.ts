import type { Db } from "../db";

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
}

/** Shared buckets plus the caller's own, in the order the Follow Up page shows them. RLS hides other reps' buckets. */
export async function listBuckets(q: Db, includeInactive = false): Promise<BucketRow[]> {
  const { rows } = await q.query<BucketRow>(
    `select b.id, b.key, b.name, b.owner_id, b.rule, b.sort, b.active,
            (select count(*)::int from enrollments e where e.bucket_id = b.id and e.stopped_at is null) as members,
            (select count(*)::int from bucket_steps s where s.bucket_id = b.id) as steps
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
  /** "ET", "CT", "MT", "PT", or the IANA zone when it is none of those. */
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
  rep_name: string;
}

const TZ_LABEL = `case app.client_timezone(c)
  when 'America/New_York' then 'ET' when 'America/Chicago' then 'CT' when 'America/Denver' then 'MT'
  when 'America/Phoenix' then 'MT' when 'America/Los_Angeles' then 'PT' when 'America/Anchorage' then 'AKT'
  when 'Pacific/Honolulu' then 'HT' else app.client_timezone(c) end`;

/** The lead lines in one bucket, live enrolments only, soonest step first. */
export async function listBucketMembers(q: Db, bucketId: string): Promise<BucketMember[]> {
  const { rows } = await q.query<{ j: BucketMember }>(
    `select to_jsonb(x) as j from (
       select e.id as enrollment_id, c.id as client_id, c.business_name, c.contact_name, c.phone, c.email, c.state,
              app.client_timezone(c) as timezone, ${TZ_LABEL} as tz_label,
              (select k.wanted_amount_cents from client_asks k where k.client_id = c.id order by k.created_at desc limit 1) as wanted_amount_cents,
              e.entered_at, e.next_step, e.next_due_on::text as next_due_on, e.steps_sent, e.paused,
              (select max(a.occurred_at) from activities a where a.client_id = c.id and a.kind in ('call', 'text', 'email')) as last_touch_at,
              c.reply_waiting_since is not null as reply_waiting, c.email_opt_out, c.email_bounced_at is not null as email_bounced,
              (select count(*)::int from stips s where s.client_id = c.id and s.required and s.received_at is null) as stips_missing,
              u.name as rep_name
         from enrollments e join clients c on c.id = e.client_id join app_users u on u.id = c.user_id
        where e.bucket_id = $1 and e.stopped_at is null
          and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
        order by e.paused, e.next_due_on nulls last, c.business_name
     ) x`,
    [bucketId],
  );
  return rows.map((r) => ({
    ...r.j,
    wanted_amount_cents: r.j.wanted_amount_cents === null ? null : Number(r.j.wanted_amount_cents),
  }));
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
