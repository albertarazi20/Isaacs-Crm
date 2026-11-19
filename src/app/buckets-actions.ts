"use server";

import { recordAuditHere } from "@/lib/system/audit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireSession } from "@/lib/auth/server";
import { setBucketDailyTemplate } from "@/lib/buckets/daily";
import { queueBlast } from "@/lib/buckets/engine";
import { setTemplateApproved } from "@/lib/buckets/templates";
import { checkClaims } from "@/lib/messaging/claims";
import { MERGE_FIELDS, isMergeField, leftoverFields } from "@/lib/messaging/merge";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import { userContext } from "@/lib/data/queries";
import { id } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db, type Db } from "@/lib/db";
import { env } from "@/lib/env";
import { addDays } from "@/lib/mca/dates";

const ids = z.array(id).min(1).max(2000);

/** A rep's own bucket (managers make shared ones). */
export async function createBucketAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await requireSession();
  try {
    const i = z
      .object({ name: z.string().trim().min(1).max(60), shared: z.boolean().default(false) })
      .parse(input);
    if (i.shared && !CAN.manageTeam(session.role))
      throw new UserError("Only a manager can make a shared bucket");
    const data = await db.withUser(session.userId, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        "insert into buckets (name, owner_id, rule, sort) values ($1, $2, 'manual', 100) returning id",
        [i.name, i.shared ? null : session.userId],
      );
      return rows[0]!;
    });
    revalidatePath("/follow-up");
    return { ok: true, data };
  } catch (e) {
    // buckets_owner_name_key: the same name twice for one owner
    if ((e as { code?: string } | null)?.code === "23505")
      return { ok: false, error: "You already have a bucket with that name" };
    return { ok: false, error: toActionError(e) };
  }
}

export async function renameBucketAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const i = z
      .object({
        bucketId: id,
        name: z.string().trim().min(1).max(60),
        active: z.boolean().optional(),
      })
      .parse(input);
    await db.withUser(session.userId, async (q) => {
      const r = await q.query(
        "update buckets set name = $2, active = coalesce($3, active) where id = $1 and key is null",
        [i.bucketId, i.name, i.active ?? null],
      );
      if (r.rowCount === 0)
        throw new UserError("System buckets keep their names; only your own can change");
    });
    revalidatePath("/follow-up");
    return { ok: true, data: null };
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "23505")
      return { ok: false, error: "You already have a bucket with that name" };
    return { ok: false, error: toActionError(e) };
  }
}

type Skipped = { clientId: string; reason: string };

/**
 * Run one statement per merchant, each behind its own savepoint: a merchant who was handed off in another tab, or
 * who is gone, is reported by id and the rest still go through, instead of one failure rolling back the batch.
 */
async function eachMerchant(
  q: Db,
  clientIds: readonly string[],
  sql: string,
  params: (clientId: string) => unknown[],
): Promise<{ done: number; skipped: Skipped[] }> {
  const out = { done: 0, skipped: [] as Skipped[] };
  for (const c of clientIds) {
    await q.query("savepoint each_merchant");
    try {
      await q.query(sql, params(c));
      await q.query("release savepoint each_merchant");
      out.done += 1;
    } catch (e) {
      await q.query("rollback to savepoint each_merchant");
      await q.query("release savepoint each_merchant");
      out.skipped.push({ clientId: c, reason: toActionError(e) });
    }
  }
  return out;
}

/** Nothing went through: say why, naming the first reason (one merchant is the common case). */
const allSkipped = (skipped: readonly Skipped[]): string =>
  skipped.length === 1
    ? skipped[0]!.reason
    : `None of the ${skipped.length} merchants could be changed: ${skipped[0]!.reason}`;

/** Move the checked merchants into a bucket (their old enrolment stops). Ones that cannot move are listed, not fatal. */
export async function moveToBucketAction(
  input: unknown,
): Promise<ActionResult<{ moved: number; skipped: Skipped[] }>> {
  const session = await requireSession();
  try {
    const i = z.object({ clientIds: ids, bucketId: id }).parse(input);
    const r = await db.withUser(session.userId, (q) =>
      eachMerchant(q, i.clientIds, "select enroll_in_bucket($1, $2, 'moved')", (c) => [
        c,
        i.bucketId,
      ]),
    );
    if (r.done === 0) return { ok: false, error: allSkipped(r.skipped) };
    revalidatePath("/follow-up");
    return { ok: true, data: { moved: r.done, skipped: r.skipped } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function removeFromBucketAction(
  input: unknown,
): Promise<ActionResult<{ removed: number; skipped: Skipped[] }>> {
  const session = await requireSession();
  try {
    const i = z.object({ clientIds: ids }).parse(input);
    const r = await db.withUser(session.userId, (q) =>
      eachMerchant(q, i.clientIds, "select stop_enrollment($1, 'removed')", (c) => [c]),
    );
    if (r.done === 0) return { ok: false, error: allSkipped(r.skipped) };
    revalidatePath("/follow-up");
    return { ok: true, data: { removed: r.done, skipped: r.skipped } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/**
 * Pause or resume. `until` (a day after today) pauses with a date on it: the engine lifts the pause by itself that
 * day, in the merchant's zone, and the lead line says "Paused until Nov 30". Without it the pause lasts until a
 * person resumes. Resuming clears the date (set_enrollment_paused).
 */
export async function pauseEnrollmentAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const i = z
      .object({
        clientIds: ids,
        paused: z.boolean(),
        until: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a day")
          .optional(),
      })
      .parse(input);
    if (i.until && !i.paused) throw new UserError("A date only goes with a pause");
    // the SQL function holds or releases the queued steps with the flag, so a pause reaches the outbox (S1-2)
    await db.withUser(session.userId, async (q) => {
      if (i.until) {
        const { today } = await userContext(q);
        if (i.until <= today) throw new UserError("Pick a day after today");
        if (i.until > addDays(today, 365)) throw new UserError("Pick a day within a year");
      }
      for (const c of i.clientIds) {
        await q.query("select set_enrollment_paused($1, $2)", [c, i.paused]);
        // the function pauses; the date is the engine's cue to resume (enrollments.resume_on, 0501)
        if (i.until)
          await q.query(
            "update enrollments set resume_on = $2 where client_id = $1 and stopped_at is null and paused",
            [c, i.until],
          );
      }
    });
    revalidatePath("/follow-up");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** One template to the checked merchants, through the outbox: cap, window, footer and stop rules all apply. */
export async function blastAction(
  input: unknown,
): Promise<ActionResult<{ queued: number; skipped: { clientId: string; reason: string }[] }>> {
  const session = await requireSession();
  try {
    const i = z.object({ templateId: id, clientIds: ids }).parse(input);
    const data = await db.withUser(session.userId, (q) =>
      queueBlast(q, { templateId: i.templateId, clientIds: i.clientIds, appUrl: env().APP_URL }),
    );
    await recordAuditHere({
      kind: "blast_sent",
      userId: session.userId,
      email: session.email,
      detail: { template_id: i.templateId, chosen: i.clientIds.length, queued: data.queued },
    });
    revalidatePath("/follow-up");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

const FIELD_LIST = MERGE_FIELDS.map((f) => `{${f}}`).join(", ");

/** A typo like {firstname} would reach the merchant as typed, so a template with an unknown token is not saved. */
const templateSchema = z
  .object({
    id: id.optional(),
    name: z.string().trim().min(1).max(80),
    subject: z.string().trim().max(200).default(""),
    body: z.string().trim().min(1).max(5000),
    shared: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    for (const field of ["subject", "body"] as const) {
      for (const token of leftoverFields(v[field])) {
        if (!isMergeField(token.slice(1, -1))) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `${token} isn't a field I know. The fields are ${FIELD_LIST}.`,
          });
          return;
        }
      }
    }
  });

/** A rep's template waits for a manager's approval before the engine sends it on its own. */
export async function saveTemplateAction(
  input: unknown,
): Promise<ActionResult<{ id: string; claimReasons?: string[] }>> {
  const session = await requireSession();
  try {
    const i = templateSchema.parse(input);
    const manager = CAN.manageTeam(session.role);
    if (i.shared && !manager) throw new UserError("Only a manager can make a shared template");
    // the claim checker runs on every save, not only on the approve button: a manager's save is never a way around it
    // (S1-15). A template that fails is still saved, but unapproved, with the reasons handed back.
    const claims = checkClaims(`${i.subject}\n${i.body}`);
    const mayApprove = manager && claims.ok;
    const claimReasons = claims.ok ? undefined : claims.reasons;
    const data = await db.withUser(session.userId, async (q) => {
      if (i.id) {
        const r = await q.query<{ id: string }>(
          `update templates set name = $2, subject = $3, body = $4,
                  approved = case when $5 then approved else false end, approved_by = case when $5 then approved_by end, approved_at = case when $5 then approved_at end
            where id = $1 returning id`,
          [i.id, i.name, i.subject, i.body, mayApprove],
        );
        if (r.rowCount === 0) throw new UserError("Template not found");
        return { id: i.id, claimReasons };
      }
      const r = await q.query<{ id: string }>(
        `insert into templates (owner_id, name, subject, body, approved, approved_by, approved_at, created_by)
         values ($1, $2, $3, $4, $5, case when $5 then $6::uuid end, case when $5 then now() end, $6) returning id`,
        [i.shared ? null : session.userId, i.name, i.subject, i.body, mayApprove, session.userId],
      );
      return { id: r.rows[0]!.id, claimReasons };
    });
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function approveTemplateAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    if (!CAN.manageTeam(session.role)) throw new UserError("Only a manager approves templates");
    const i = z.object({ templateId: id, approved: z.boolean() }).parse(input);
    // the claim checker runs here: a template that fails it stays unapproved, with the reasons (S1-15)
    await db.withUser(session.userId, (q) => setTemplateApproved(q, i.templateId, i.approved));
    await recordAuditHere({
      kind: "template_approval_changed",
      userId: session.userId,
      email: session.email,
      detail: { template_id: i.templateId, approved: i.approved },
    });
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function archiveTemplateAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const i = z.object({ templateId: id, archived: z.boolean() }).parse(input);
    await db.withUser(session.userId, (q) =>
      q.query("update templates set archived = $2 where id = $1", [i.templateId, i.archived]),
    );
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

const stepsSchema = z.object({
  bucketId: id,
  steps: z
    .array(
      z.object({
        dayOffset: z.coerce.number().int().min(0).max(365),
        templateId: id.nullable(),
        action: z.enum(["email", "call", "move_to_cold"]).default("email"),
      }),
    )
    .max(12),
});

/** Replace a bucket's sequence. A rep edits their own buckets; managers edit the shared ones. */
export async function setBucketStepsAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const i = stepsSchema.parse(input);
    await db.withUser(session.userId, async (q) => {
      const b = (
        await q.query<{ owner_id: string | null }>("select owner_id from buckets where id = $1", [
          i.bucketId,
        ])
      ).rows[0];
      if (!b) throw new UserError("Bucket not found");
      if (b.owner_id === null && !CAN.manageTeam(session.role))
        throw new UserError("Only a manager edits a shared bucket's sequence");
      await q.query("delete from bucket_steps where bucket_id = $1", [i.bucketId]);
      let n = 1;
      for (const s of i.steps) {
        await q.query(
          "insert into bucket_steps (bucket_id, step_no, day_offset, template_id, action) values ($1, $2, $3, $4, $5)",
          [i.bucketId, n++, s.dayOffset, s.action === "email" ? s.templateId : null, s.action],
        );
      }
    });
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Manager only: the template a bucket sends to every member once a day, or none (the step list is used). */
export async function setBucketDailyTemplateAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    if (!CAN.manageTeam(session.role))
      throw new UserError("Only a manager picks a bucket's daily reminder");
    const i = z.object({ bucketId: id, templateId: id.nullable() }).parse(input);
    await db.withUser(session.userId, (q) => setBucketDailyTemplate(q, i));
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
