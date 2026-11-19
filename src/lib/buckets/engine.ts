import { applyLink } from "../docs/applyLink";
import { missingDocsFor } from "../docs/missing";
import type { Db, DbAccess } from "../db";
import { addDays, todayIn, type ISODate } from "../mca/dates";
import { effectiveSignature, mergeValues, resolveMergeFields } from "../messaging/merge";
import { enqueueEmail } from "../send/enqueue";
import { nextDailySend, nextNonSaturday } from "../send/rules";
import { describeUnknownFields, unknownFieldsNote, unknownFieldsOf } from "./unknownFields";

/** How many days a step whose template cannot send is held before the sequence moves on without it. */
const MAX_HOLD_DAYS = 3;
/**
 * The hold is counted in elapsed time from `enrollments.hold_since`. A step is retried once a day at the first cron
 * tick of the merchant's day, so the run that ends the hold lands up to an hour or so short of exactly 3 x 24 h; this
 * slack keeps the limit at three daily tries and not four.
 */
const HOLD_LIMIT_MS = MAX_HOLD_DAYS * 86_400_000 - 2 * 3_600_000;

/**
 * The bucket sequence runner. Once a day (or whenever the cron fires) it finds every live enrolment whose next
 * step is due in the merchant's local day and performs it: queue the step's template on the outbox, open a call
 * task, or move the merchant to Cold. Then it schedules the following step. When a bucket's sequence runs out the
 * merchant goes to Cold; Cold itself keeps its members after its last nudge, with nothing more scheduled. It never
 * sends itself: the outbox worker does, inside the send window and under the cap. With sequences switched off in
 * Settings, step 1 repeats daily until a stop rule fires. Two runs at once are safe: each enrolment is locked and
 * re-read before its step is taken, and the outbox holds one pending copy of a step (0543).
 */

export interface RunSummary {
  due: number;
  emailed: number;
  called: number;
  moved: number;
  finished: number;
  skipped: number;
  /** Enrolments paused with a date ("not now until…") that re-opened today. */
  resumed: number;
  /** Due rows another run was already working on, or had already done: left alone. */
  taken: number;
}

interface DueRow {
  enrollment_id: string;
  user_id: string;
  client_id: string;
  bucket_id: string;
  bucket_name: string;
  bucket_key: string | null;
  /** Set: the bucket sends this template to every member once a day instead of running its steps. */
  daily_template_id: string | null;
  next_step: number;
  next_due_on: string;
  steps_sent: number;
  timezone: string;
  contact_name: string;
  business_name: string;
  email: string;
  sender_name: string;
  application_link: string;
  application_token: string;
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

/** A daily bucket's one "step": its reminder template, repeated every day. */
async function dailyStepFor(q: Db, templateId: string): Promise<StepRow[]> {
  const { rows } = await q.query<StepRow>(
    `select 1 as step_no, 0 as day_offset, t.id as template_id, 'email' as action, t.subject, t.body,
            app.template_may_auto_send(t.id) as may_send,
            coalesce((select jsonb_agg(jsonb_build_object('subject', v.subject, 'body', v.body) order by v.sort)
                        from template_variants v where v.template_id = t.id), '[]'::jsonb) as variants
       from templates t where t.id = $1`,
    [templateId],
  );
  return rows;
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
  const summary: RunSummary = {
    due: 0,
    emailed: 0,
    called: 0,
    moved: 0,
    finished: 0,
    skipped: 0,
    resumed: 0,
    taken: 0,
  };
  const settings = await args.db.withSystem(
    async (q) =>
      (
        await q.query<{ v: boolean; m: number }>(
          "select sequences_enabled as v, daily_reminder_minute as m from shop_settings",
        )
      ).rows[0],
  );
  const sequences = settings?.v ?? true;
  const reminderMinute = settings?.m ?? 600;
  // a pause with a date on it ("not now until January", S1-6) lifts by itself on the day, in the merchant's zone
  summary.resumed = await args.db.withSystem(async (q) => {
    const { rows } = await q.query<{ user_id: string; client_id: string; bucket_name: string }>(
      `with lifted as (
         update enrollments e set paused = false, resume_on = null
           from clients c
          where e.client_id = c.id and e.stopped_at is null and e.paused and e.resume_on is not null
            and c.brought_in_at is null
            and e.resume_on <= (($1::timestamptz at time zone app.client_timezone(c))::date)
          returning e.user_id, e.client_id, e.bucket_id),
       cleared as (
         update clients c set revive_on = null from lifted l where c.id = l.client_id and c.revive_on is not null)
       select l.user_id, l.client_id, b.name as bucket_name from lifted l join buckets b on b.id = l.bucket_id`,
      [now.toISOString()],
    );
    for (const r of rows)
      await q.query(
        "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
        [
          r.user_id,
          r.client_id,
          `Follow-up emails resumed: the merchant said to check back now (${r.bucket_name})`,
        ],
      );
    return rows.length;
  });
  const due = await args.db.withSystem(async (q) => {
    const { rows } = await q.query<DueRow>(
      `select e.id as enrollment_id, e.user_id, e.client_id, e.bucket_id, b.name as bucket_name, b.key as bucket_key,
              b.daily_template_id, e.next_step, e.next_due_on::text as next_due_on, e.steps_sent,
              app.client_timezone(c) as timezone, c.contact_name, c.business_name, c.email,
              u.name as sender_name, u.application_link, c.application_token, u.signature,
              (select wanted_amount_cents from client_asks k where k.client_id = c.id order by created_at desc limit 1) as wanted_amount_cents,
              c.upload_token
         from enrollments e
         join clients c on c.id = e.client_id
         join buckets b on b.id = e.bucket_id
         join app_users u on u.id = e.user_id
        where e.stopped_at is null and not e.paused and e.next_due_on is not null
          and u.active
          and e.next_due_on <= (($1::timestamptz at time zone app.client_timezone(c))::date)
          and c.contact_status <> 'dnc'
          and c.brought_in_at is null
          and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
        order by e.next_due_on, e.entered_at`,
      [now.toISOString()],
    );
    return rows;
  });
  summary.due = due.length;

  for (const row of due) {
    await args.db.withSystem(async (q) => {
      // another run may hold this enrolment, or may have taken this step already: lock it and re-read it first
      const mine = await q.query<{ hold_since: Date | null }>(
        `select hold_since from enrollments
          where id = $1 and stopped_at is null and not paused and next_step = $2 and next_due_on = $3::date
          for update skip locked`,
        [row.enrollment_id, row.next_step, row.next_due_on],
      );
      if (mine.rowCount === 0) {
        summary.taken += 1;
        return;
      }
      const holdSince = mine.rows[0]?.hold_since ?? null;
      const daily = row.daily_template_id !== null;
      const steps = daily
        ? await dailyStepFor(q, row.daily_template_id ?? "")
        : await stepsFor(q, row.bucket_id);
      const today: ISODate = todayIn(row.timezone, now);
      // a daily bucket: the shop's reminder time in the merchant's own zone, every day but Saturday
      const slot = daily ? nextDailySend(now, row.timezone, reminderMinute) : null;
      if (steps.length === 0) {
        // a bucket with no steps (Cold, S1-14) holds its members without chasing them: nothing is due, ever
        await q.query("update enrollments set next_due_on = null where id = $1", [
          row.enrollment_id,
        ]);
        summary.skipped += 1;
        return;
      }
      // the sequence ran out: Cold keeps its member with nothing more scheduled; any other bucket hands over to Cold,
      // unless the chase is over for good (handed off, opted out, bounced), when the enrolment simply ends
      const finish = async (took: number) => {
        summary.finished += 1;
        if (row.bucket_key === "cold") {
          await q.query(
            "update enrollments set next_due_on = null, next_step = next_step + $2, steps_sent = steps_sent + $2, hold_since = null where id = $1",
            [row.enrollment_id, took],
          );
          return;
        }
        await q.query(
          "update enrollments set stopped_at = now(), stop_reason = 'sequence_done', steps_sent = steps_sent + $2, hold_since = null where id = $1",
          [row.enrollment_id, took],
        );
        if (
          steps.some((st) => st.action === "email") &&
          (await emailsSent(q, row.client_id, row.bucket_id, true)) === 0
        )
          await q.query(
            "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
            [
              row.user_id,
              row.client_id,
              `The ${row.bucket_name} sequence ended with none of its emails actually sent`,
            ],
          );
        const cold = (
          await q.query<{ id: string }>(
            "select b.id from buckets b where b.key = 'cold' and b.active and not app.chase_closed($1)",
            [row.client_id],
          )
        ).rows[0]?.id;
        if (cold) {
          await q.query("select enroll_in_bucket($1, $2, 'sequence_done')", [row.client_id, cold]);
          summary.moved += 1;
        }
      };
      const step = daily
        ? steps[0]
        : sequences
          ? steps.find((s) => s.step_no === row.next_step)
          : steps.find((s) => s.action === "email");
      if (!step) {
        await finish(0);
        return;
      }
      const after = daily || !sequences ? step : steps.find((s) => s.step_no === step.step_no + 1);
      // `counted` is true only when an email really went on the outbox: steps_sent feeds the "N sent" line, the
      // export and the "no reply to N emails" call note, so a skipped step must not add to it
      const scheduleNext = async (counted: boolean) => {
        if (!after) {
          await finish(counted ? 1 : 0);
          return;
        }
        // with sequences off, "tomorrow" again; with them on, entered_at + the next step's offset (never in the past)
        const nextDue = slot
          ? nextNonSaturday(counted ? slot.date : today)
          : sequences
            ? maxDate(addDays(today, 1), addDays(await enteredDay(row, q), after.day_offset))
            : addDays(today, 1);
        await q.query(
          "update enrollments set next_step = $2, next_due_on = $3, steps_sent = steps_sent + $4, hold_since = null where id = $1",
          [row.enrollment_id, sequences && !daily ? after.step_no : 1, nextDue, counted ? 1 : 0],
        );
      };

      // "move to Cold" is the sequence handing over early: the same guards as running out (Cold must be active and
      // the chase still open; otherwise the enrolment simply ends)
      if (step.action === "move_to_cold") {
        await finish(0);
        return;
      }
      if (step.action === "call") {
        // the note counts emails that really went out: a step that was queued and then expired unsent (Gmail not
        // connected, held by the claim check...) is not an email the merchant got and did not answer
        const sentN = await emailsSent(q, row.client_id, row.bucket_id);
        await q.query(
          `insert into timers (user_id, client_id, kind, due_on, note)
           select $1, $2, 'follow_up', $3, $4
            where not exists (select 1 from timers where client_id = $2 and done_at is null and kind = 'follow_up' and due_on <= $3)`,
          [
            row.user_id,
            row.client_id,
            today,
            sentN > 0
              ? `Call: no reply to ${sentN} email${sentN === 1 ? "" : "s"} (${row.bucket_name})`
              : `Call: no email has gone out yet (${row.bucket_name})`,
          ],
        );
        summary.called += 1;
        await scheduleNext(false);
        return;
      }
      // A step that cannot go out today (its template is archived, not approved or paused after a bounce spike; or it
      // names a merge field that does not exist) is held and tried again tomorrow, so it goes out when it is fixed. The
      // hold has a limit, counted from the moment it began (`hold_since`): a template that stays broken would otherwise
      // freeze this merchant on the step, and every later step, for good. It never touches the enrolment's pause flag,
      // which belongs to the rep's Pause and the merchant's "not now" and is lifted only by them.
      const holdStep = async (note: string) => {
        summary.skipped += 1;
        if (holdSince === null) {
          // the hold begins today: stamp it and say so once (a second, later break gets its own note and its own clock)
          await q.query("update enrollments set hold_since = $2 where id = $1", [
            row.enrollment_id,
            now.toISOString(),
          ]);
          await q.query(
            "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
            [row.user_id, row.client_id, note],
          );
        }
        if (holdSince !== null && now.getTime() - holdSince.getTime() >= HOLD_LIMIT_MS) {
          await q.query(
            "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
            [
              row.user_id,
              row.client_id,
              `Bucket email skipped: the template for step ${step.step_no} could not send for ${MAX_HOLD_DAYS} days (${row.bucket_name})`,
            ],
          );
          await scheduleNext(false);
          return;
        }
        await q.query("update enrollments set next_due_on = $2 where id = $1", [
          row.enrollment_id,
          addDays(today, 1),
        ]);
      };
      if (step.template_id && !step.may_send) {
        await holdStep(
          `Bucket email on hold: the template for step ${step.step_no} cannot send right now (${row.bucket_name})`,
        );
        return;
      }
      if (!step.template_id || !row.email) {
        summary.skipped += 1;
        await scheduleNext(false);
        return;
      }
      const wording = pickWording(step, row.client_id);
      const values = mergeValues({
        contactName: row.contact_name,
        businessName: row.business_name,
        senderName: row.sender_name,
        applicationLink: row.application_link || applyLink(args.appUrl, row.application_token),
        wantedAmountCents: row.wanted_amount_cents,
        uploadLink: `${args.appUrl}/upload/${row.upload_token}`,
        missingDocs: await missingDocsFor(q, row.client_id, row.bucket_key),
      });
      const body = resolveMergeFields(wording.body, values);
      const subject = resolveMergeFields(wording.subject, values);
      // a template with a field that does not exist ({frist_name}) never goes out with the literal text in it: the
      // step is held (not lost, and the rep's pause is left alone) and the merchant's timeline says why, once per hold
      const unknown = unknownFieldsOf(body, subject);
      if (unknown.length > 0) {
        await holdStep(
          unknownFieldsNote({
            what: `Bucket email on hold: step ${step.step_no} (${row.bucket_name}) was`,
            names: unknown,
          }),
        );
        return;
      }
      // a template with a blank field never goes out half-filled: the step is held like any other that cannot go out
      // today (retried daily, since the field may get filled in; skipped after the limit) and the pause flag, which is
      // the rep's and the merchant's, is never set
      const blank = [...new Set([...body.missing, ...subject.missing])];
      if (blank.length > 0) {
        await holdStep(
          `Bucket email on hold: step ${step.step_no} (${row.bucket_name}) not sent: the template needs ${blank.join(", ")}, which this merchant does not have yet. It is tried again daily.`,
        );
        return;
      }
      const text = `${body.text.replace(/\s+$/, "")}\n\n${effectiveSignature(row.signature, row.sender_name)}`;
      const r = await enqueueEmail(
        q,
        {
          clientId: row.client_id,
          lane: "sequence",
          source: slot
            ? `bucket:${row.bucket_id}:daily:${slot.date}`
            : `bucket:${row.bucket_id}:step:${step.step_no}`,
          subject: subject.text || `About ${row.business_name}`,
          text,
          when: "window",
          ...(slot ? { at: slot.at, expiresInHours: 4 } : { expiresInHours: 36 }),
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
      await scheduleNext(r.queued);
    });
  }
  return summary;
}

/** How many of this bucket's sequence emails really went out to the merchant; expired or cancelled ones never count, queued ones only with `alsoPending`. */
async function emailsSent(
  q: Db,
  clientId: string,
  bucketId: string,
  alsoPending = false,
): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `select count(*)::int as n from outbox
      where client_id = $1 and lane = 'sequence' and source like $2
        and (status = 'sent' or ($3 and status in ('queued', 'sending')))`,
    [clientId, `bucket:${bucketId}:step:%`, alsoPending],
  );
  return rows[0]?.n ?? 0;
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
  // "pressing Blast twice is the same row" holds for the rep's whole day, not a UTC day (which ends at 7pm ET)
  const day = (
    await q.query<{ d: string }>(
      `select ($1::timestamptz at time zone coalesce(
                 (select nullif(timezone, '') from app.my_user),
                 'America/New_York'))::date::text as d`,
      [now.toISOString()],
    )
  ).rows[0]!.d;
  const blastId = `blast:${args.templateId}:${day}`;
  for (const clientId of args.clientIds) {
    const row = (
      await q.query<DueRow>(
        `select c.id as client_id, c.user_id, c.contact_name, c.business_name, c.email, c.upload_token,
                u.name as sender_name, u.application_link, c.application_token, u.signature,
                (select wanted_amount_cents from client_asks k where k.client_id = c.id order by created_at desc limit 1) as wanted_amount_cents,
                '' as enrollment_id, '' as bucket_id, '' as bucket_name, null as bucket_key, 0 as next_step, '' as next_due_on,
                0 as steps_sent, app.client_timezone(c) as timezone
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
      applicationLink: row.application_link || applyLink(args.appUrl, row.application_token),
      wantedAmountCents: row.wanted_amount_cents,
      uploadLink: `${args.appUrl}/upload/${row.upload_token}`,
      missingDocs: await missingDocsFor(q, clientId),
    });
    const body = resolveMergeFields(tpl.body, values);
    const subject = resolveMergeFields(tpl.subject, values);
    const unknown = unknownFieldsOf(body, subject);
    if (unknown.length > 0) {
      out.skipped.push({ clientId, reason: `unknown field ${describeUnknownFields(unknown)}` });
      continue;
    }
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
