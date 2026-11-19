/**
 * Read-only extras for the Follow Up workspace: every bucket's sequence with the subject a merchant actually sees,
 * and each bucket's pulse today (steps due, replies waiting, paused). Run under db.withUser: row security scopes
 * both, exactly like the bucket lists they sit beside.
 */
import type { Db } from "../db";
import type { ISODate } from "../mca/dates";

export interface SequenceStep {
  bucket_id: string;
  step_no: number;
  /** Days after the merchant entered the bucket. */
  day_offset: number;
  /** 'email' | 'call' | 'move_to_cold' */
  action: string;
  template_name: string | null;
  template_subject: string | null;
  template_approved: boolean | null;
  /** The one step of a bucket with a daily reminder (0593): sent every day but Saturday, not on a day count. */
  daily: boolean;
  /** For that step: the shop's reminder time, minutes after the merchant's local midnight. */
  daily_minute: number | null;
}

/**
 * Every active bucket's steps, in order, keyed by bucket id. A bucket without a sequence has no key. A bucket with a
 * daily reminder ignores its step list (the engine sends the template every day), so it reads as that one step.
 */
export async function listSequences(q: Db): Promise<Record<string, SequenceStep[]>> {
  const { rows } = await q.query<SequenceStep>(
    `select s.bucket_id, s.step_no, s.day_offset, s.action,
            t.name as template_name, t.subject as template_subject, t.approved as template_approved,
            false as daily, null::int as daily_minute
       from bucket_steps s
       join buckets b on b.id = s.bucket_id and b.active and b.daily_template_id is null
       left join templates t on t.id = s.template_id
     union all
     select b.id, 1, 0, 'email', t.name, t.subject, app.template_may_auto_send(b.daily_template_id),
            true, (select daily_reminder_minute from shop_settings)
       from buckets b
       left join templates t on t.id = b.daily_template_id
      where b.active and b.daily_template_id is not null
      order by bucket_id, step_no`,
  );
  const out: Record<string, SequenceStep[]> = {};
  for (const r of rows) (out[r.bucket_id] ??= []).push(r);
  return out;
}

export interface BucketPulse {
  /** A step is due today or overdue, and the merchant is not paused. */
  due_today: number;
  /** The merchant replied and nobody has answered yet. */
  replied: number;
  paused: number;
}

/** Live enrolments per bucket that need a look today. Merchants in the trash never count. */
export async function bucketPulse(q: Db, today: ISODate): Promise<Record<string, BucketPulse>> {
  const { rows } = await q.query<BucketPulse & { bucket_id: string }>(
    `select e.bucket_id,
            count(*) filter (where not e.paused and e.next_due_on is not null and e.next_due_on <= $1::date)::int as due_today,
            count(*) filter (where c.reply_waiting_since is not null)::int as replied,
            count(*) filter (where e.paused)::int as paused
       from enrollments e
       join clients c on c.id = e.client_id
      where e.stopped_at is null
        and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
      group by e.bucket_id`,
    [today],
  );
  return Object.fromEntries(rows.map(({ bucket_id, ...pulse }) => [bucket_id, pulse]));
}
