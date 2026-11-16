"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireSession } from "@/lib/auth/server";
import { queueBlast } from "@/lib/buckets/engine";
import { setTemplateApproved } from "@/lib/buckets/templates";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import { id } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

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
    return { ok: false, error: toActionError(e) };
  }
}

/** Move the checked merchants into a bucket (their old enrolment stops). */
export async function moveToBucketAction(input: unknown): Promise<ActionResult<{ moved: number }>> {
  const session = await requireSession();
  try {
    const i = z.object({ clientIds: ids, bucketId: id }).parse(input);
    const moved = await db.withUser(session.userId, async (q) => {
      let n = 0;
      for (const c of i.clientIds) {
        await q.query("select enroll_in_bucket($1, $2, 'moved')", [c, i.bucketId]);
        n++;
      }
      return n;
    });
    revalidatePath("/follow-up");
    return { ok: true, data: { moved } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function removeFromBucketAction(
  input: unknown,
): Promise<ActionResult<{ removed: number }>> {
  const session = await requireSession();
  try {
    const i = z.object({ clientIds: ids }).parse(input);
    const removed = await db.withUser(session.userId, async (q) => {
      let n = 0;
      for (const c of i.clientIds) {
        await q.query("select stop_enrollment($1, 'removed')", [c]);
        n++;
      }
      return n;
    });
    revalidatePath("/follow-up");
    return { ok: true, data: { removed } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function pauseEnrollmentAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const i = z.object({ clientIds: ids, paused: z.boolean() }).parse(input);
    // the SQL function holds or releases the queued steps with the flag, so a pause reaches the outbox (S1-2)
    await db.withUser(session.userId, async (q) => {
      for (const c of i.clientIds)
        await q.query("select set_enrollment_paused($1, $2)", [c, i.paused]);
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
    revalidatePath("/follow-up");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

const templateSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(80),
  subject: z.string().trim().max(200).default(""),
  body: z.string().trim().min(1).max(5000),
  shared: z.boolean().default(false),
});

/** A rep's template waits for a manager's approval before the engine sends it on its own. */
export async function saveTemplateAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const session = await requireSession();
  try {
    const i = templateSchema.parse(input);
    const manager = CAN.manageTeam(session.role);
    if (i.shared && !manager) throw new UserError("Only a manager can make a shared template");
    const data = await db.withUser(session.userId, async (q) => {
      if (i.id) {
        const r = await q.query<{ id: string }>(
          `update templates set name = $2, subject = $3, body = $4,
                  approved = case when $5 then approved else false end, approved_by = case when $5 then approved_by end, approved_at = case when $5 then approved_at end
            where id = $1 returning id`,
          [i.id, i.name, i.subject, i.body, manager],
        );
        if (r.rowCount === 0) throw new UserError("Template not found");
        return { id: i.id };
      }
      const r = await q.query<{ id: string }>(
        `insert into templates (owner_id, name, subject, body, approved, approved_by, approved_at, created_by)
         values ($1, $2, $3, $4, $5, case when $5 then $6::uuid end, case when $5 then now() end, $6) returning id`,
        [i.shared ? null : session.userId, i.name, i.subject, i.body, manager, session.userId],
      );
      return r.rows[0]!;
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
