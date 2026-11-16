import type { Db, DbAccess } from "../db";
import { addDays, todayIn, type ISODate } from "../mca/dates";
import { effectiveSignature, mergeValues, resolveMergeFields } from "../messaging/merge";
import { enqueueEmail } from "../send/enqueue";

/**
 * The bucket sequence runner. Once a day (or whenever the cron fires) it finds every live enrolment whose next
 * step is due in the merchant's local day and performs it: queue the step's template on the outbox, open a call
 * task, or move the merchant to Cold. Then it schedules the following step. It never sends itself: the outbox
 * worker does, inside the send window and under the cap. With sequences switched off in Settings, step 1 repeats
 * daily until a stop rule fires.
 */

export interface RunSummary {
  due: number;
  emailed: number;
  called: number;
  moved: number;
  finished: number;
  skipped: number;
}

interface DueRow {
  enrollment_id: string;
  user_id: string;
  client_id: string;
  bucket_id: string;
  bucket_name: string;
  next_step: number;
  steps_sent: number;
  timezone: string;
  contact_name: string;
  business_name: string;
  email: string;
  sender_name: string;
  application_link: string;
  signature: string;
  wanted_amount_cents: number | null;
  upload_token: string;
}

interface StepRow {
  step_no: number;
  day_offset: number;
  template_id: string | null;
  action: "email" | "call" | "move_to_cold";
  subject: string | null;
  body: string | null;
  may_send: boolean | null;
  variants: { subject: string; body: string }[];
}

async function stepsFor(q: Db, bucketId: string): Promise<StepRow[]> {
  const { rows } = await q.query<StepRow>(
    `select s.step_no, s.day_offset, s.template_id, s.action, t.subject, t.body,
            app.template_may_auto_send(s.template_id) as may_send,
            coalesce((select jsonb_agg(jsonb_build_object('subject', v.subject, 'body', v.body) order by v.sort)
                        from template_variants v where v.template_id = s.template_id), '[]'::jsonb) as variants
       from bucket_steps s left join templates t on t.id = s.template_id
      where s.bucket_id = $1 order by s.step_no`,
    [bucketId],
  );
  return rows;
}

/** Pick a wording for this merchant: the template itself or one of its variants, stable per merchant+step. */
function pickWording(step: StepRow, clientId: string): { subject: string; body: string } {
  const all = [{ subject: step.subject ?? "", body: step.body ?? "" }, ...step.variants].filter(
    (v) => v.body.trim() !== "",
  );
  if (all.length === 0) return { subject: "", body: "" };
  let h = 0;
  for (const ch of clientId + step.step_no) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return all[h % all.length] ?? all[0]!;
}

export async function runBucketSteps(args: {
  db: DbAccess;
  now?: Date;
  appUrl: string;
}): Promise<RunSummary> {
  const now = args.now ?? new Date();
  const summary: RunSummary = { due: 0, emailed: 0, called: 0, moved: 0, finished: 0, skipped: 0 };
  const sequences = await args.db.withSystem(
    async (q) =>
      (await q.query<{ v: boolean }>("select sequences_enabled as v from shop_settings")).rows[0]
        ?.v ?? true,
  );
  const due = await args.db.withSystem(async (q) => {
    const { rows } = await q.query<DueRow>(
      `select e.id as enrollment_id, e.user_id, e.client_id, e.bucket_id, b.name as bucket_name, e.next_step, e.steps_sent,
              app.client_timezone(c) as timezone, c.contact_name, c.business_name, c.email,
              u.name as sender_name, u.application_link, u.signature,
              (select wanted_amount_cents from client_asks k where k.client_id = c.id order by created_at desc limit 1) as wanted_amount_cents,
              c.upload_token
         from enrollments e
         join clients c on c.id = e.client_id
         join buckets b on b.id = e.bucket_id
         join app_users u on u.id = e.user_id
        where e.stopped_at is null and not e.paused and e.next_due_on is not null
          and e.next_due_on <= (($1::timestamptz at time zone app.client_timezone(c))::date)
          and c.contact_status <> 'dnc'
          and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
        order by e.next_due_on, e.entered_at`,
      [now.toISOString()],
    );
    return rows;
  });
  summary.due = due.length;

  for (const row of due) {
    await args.db.withSystem(async (q) => {
      const steps = await stepsFor(q, row.bucket_id);
      const today: ISODate = todayIn(row.timezone, now);
      const step = sequences
        ? steps.find((s) => s.step_no === row.next_step)
        : steps.find((s) => s.action === "email");
      if (!step) {
        await q.query(
          "update enrollments set stopped_at = now(), stop_reason = 'sequence_done' where id = $1",
          [row.enrollment_id],
        );
        summary.finished += 1;
        return;
      }
      const after = sequences ? steps.find((s) => s.step_no === step.step_no + 1) : step;
      const scheduleNext = async () => {
        if (!after) {
          await q.query(
            "update enrollments set stopped_at = now(), stop_reason = 'sequence_done', steps_sent = steps_sent + 1 where id = $1",
            [row.enrollment_id],
          );
          summary.finished += 1;
          return;
        }
        // with sequences off, "tomorrow" again; with them on, entered_at + the next step's offset (never in the past)
        const nextDue = sequences
          ? maxDate(addDays(today, 1), addDays(await enteredDay(row, q), after.day_offset))
          : addDays(today, 1);
        await q.query(
          "update enrollments set next_step = $2, next_due_on = $3, steps_sent = steps_sent + 1 where id = $1",
          [row.enrollment_id, sequences ? after.step_no : 1, nextDue],
        );
      };

      if (step.action === "move_to_cold") {
        const cold = (await q.query<{ id: string }>("select id from buckets where key = 'cold'"))
          .rows[0]?.id;
        if (cold)
          await q.query("select enroll_in_bucket($1, $2, 'sequence_done')", [row.client_id, cold]);
        summary.moved += 1;
        return;
      }
      if (step.action === "call") {
        await q.query(
          `insert into timers (user_id, client_id, kind, due_on, note)
           select $1, $2, 'follow_up', $3, $4
            where not exists (select 1 from timers where client_id = $2 and done_at is null and kind = 'follow_up' and due_on <= $3)`,
          [
            row.user_id,
            row.client_id,
            today,
            `Call: no reply to ${row.steps_sent} emails (${row.bucket_name})`,
          ],
        );
        summary.called += 1;
        await scheduleNext();
        return;
      }
      if (!step.template_id || !step.may_send || !row.email) {
        summary.skipped += 1;
        await scheduleNext();
        return;
      }
      const wording = pickWording(step, row.client_id);
      const values = mergeValues({
        contactName: row.contact_name,
        businessName: row.business_name,
        senderName: row.sender_name,
        applicationLink: row.application_link,
        wantedAmountCents: row.wanted_amount_cents,
        bestOffer: null,
        uploadLink: `${args.appUrl}/upload/${row.upload_token}`,
      });
      const body = resolveMergeFields(wording.body, values);
      const subject = resolveMergeFields(wording.subject, values);
      // a template with a blank field never goes out half-filled: skip and flag it on the enrolment
      if (body.missing.length > 0 || subject.missing.length > 0) {
        summary.skipped += 1;
        await q.query("update enrollments set paused = true where id = $1", [row.enrollment_id]);
        await q.query(
          "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
          [
            row.user_id,
            row.client_id,
            `Bucket email paused: the template needs ${[...body.missing, ...subject.missing].join(", ")}`,
          ],
        );
        return;
      }
      const text = `${body.text.replace(/\s+$/, "")}\n\n${effectiveSignature(row.signature, row.sender_name)}`;
      const r = await enqueueEmail(
        q,
        {
          clientId: row.client_id,
          lane: "sequence",
          source: `bucket:${row.bucket_id}:step:${step.step_no}`,
          subject: subject.text || `About ${row.business_name}`,
          text,
          when: "window",
          expiresInHours: 36,
          templateId: step.template_id,
        },
        now,
      );
      if (r.queued) {
        await q.query("update enrollments set last_outbox_id = $2 where id = $1", [
          row.enrollment_id,
          r.outboxId,
        ]);
        summary.emailed += 1;
      } else {
        summary.skipped += 1;
      }
      await scheduleNext();
    });
  }
  return summary;
}

async function enteredDay(row: DueRow, q: Db): Promise<ISODate> {
  const { rows } = await q.query<{ d: string }>(
    "select (entered_at at time zone $2)::date::text as d from enrollments where id = $1",
    [row.enrollment_id, row.timezone],
  );
  return rows[0]?.d ?? todayIn(row.timezone);
}

function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}

/** A manual blast: one template to a chosen set of merchants, through the outbox (cap, footer, stop rules apply). */
export async function queueBlast(
  q: Db,
  args: { templateId: string; clientIds: string[]; appUrl: string; now?: Date },
): Promise<{ queued: number; skipped: { clientId: string; reason: string }[] }> {
  const now = args.now ?? new Date();
  const tpl = (
    await q.query<{ subject: string; body: string }>(
      "select subject, body from templates where id = $1 and not archived and app.template_may_auto_send(id)",
      [args.templateId],
    )
  ).rows[0];
  if (!tpl) throw new Error("template not found");
  const out = { queued: 0, skipped: [] as { clientId: string; reason: string }[] };
  const blastId = `blast:${args.templateId}:${now.toISOString().slice(0, 10)}`;
  for (const clientId of args.clientIds) {
    const row = (
      await q.query<DueRow>(
        `select c.id as client_id, c.user_id, c.contact_name, c.business_name, c.email, c.upload_token,
                u.name as sender_name, u.application_link, u.signature,
                (select wanted_amount_cents from client_asks k where k.client_id = c.id order by created_at desc limit 1) as wanted_amount_cents,
                '' as enrollment_id, '' as bucket_id, '' as bucket_name, 0 as next_step, 0 as steps_sent, app.client_timezone(c) as timezone
           from clients c join app_users u on u.id = c.user_id where c.id = $1`,
        [clientId],
      )
    ).rows[0];
    if (!row) {
      out.skipped.push({ clientId, reason: "not_found" });
      continue;
    }
    const values = mergeValues({
      contactName: row.contact_name,
      businessName: row.business_name,
      senderName: row.sender_name,
      applicationLink: row.application_link,
      wantedAmountCents: row.wanted_amount_cents,
      bestOffer: null,
      uploadLink: `${args.appUrl}/upload/${row.upload_token}`,
    });
    const body = resolveMergeFields(tpl.body, values);
    const subject = resolveMergeFields(tpl.subject, values);
    if (body.missing.length || subject.missing.length) {
      out.skipped.push({
        clientId,
        reason: `missing ${[...body.missing, ...subject.missing].join(", ")}`,
      });
      continue;
    }
    const r = await enqueueEmail(
      q,
      {
        clientId,
        lane: "blast",
        source: blastId,
        subject: subject.text || `About ${row.business_name}`,
        text: `${body.text.replace(/\s+$/, "")}\n\n${effectiveSignature(row.signature, row.sender_name)}`,
        when: "window",
        expiresInHours: 48,
        templateId: args.templateId,
      },
      now,
    );
    if (r.queued) out.queued += 1;
    else out.skipped.push({ clientId, reason: r.reason });
  }
  return out;
}
