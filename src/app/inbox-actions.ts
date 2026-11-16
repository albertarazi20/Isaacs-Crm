"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import { id, text } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { chaseLender, submitToLenders } from "@/lib/inbox/submit";
import { listProposed } from "@/lib/inbox/process";
import { sendEmailAsUser } from "@/lib/system/gmail";

const submitSchema = z.object({
  clientId: id,
  funderIds: z.array(id).min(1, "Pick at least one lender").max(50),
  note: text(500).default(""),
  extraLines: text(2000).default(""),
});

/** Ops or a manager sends the file to lenders from the CRM. */
export async function submitToLendersAction(
  input: unknown,
): Promise<ActionResult<{ sent: number; dealNumber: number }>> {
  const session = await requireSession();
  try {
    if (!CAN.runOps(session.role)) throw new UserError("Only ops or a manager can send to lenders");
    const i = submitSchema.parse(input);
    const me = await db.withUser(
      session.userId,
      async (q) =>
        (
          await q.query<{ name: string; email: string }>(
            "select name, email from app_users where id = app.current_user_id()",
          )
        ).rows[0],
    );
    const r = await db.withUser(session.userId, (q) =>
      submitToLenders(
        q,
        { ...i, senderName: me?.name || session.email, senderEmail: me?.email ?? session.email },
        (m) => sendEmailAsUser(session.userId, m),
      ),
    );
    revalidatePath("/", "layout");
    return {
      ok: true,
      data: { sent: r.submissions.filter((s) => s.to).length, dealNumber: r.dealNumber },
    };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function chaseLenderAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const { submissionId } = z.object({ submissionId: id }).parse(input);
    const me = await db.withUser(
      session.userId,
      async (q) =>
        (
          await q.query<{ name: string }>(
            "select name from app_users where id = app.current_user_id()",
          )
        ).rows[0],
    );
    const ok = await db.withUser(session.userId, (q) =>
      chaseLender(q, submissionId, me?.name || session.email, (m) =>
        sendEmailAsUser(session.userId, m),
      ),
    );
    if (!ok) throw new UserError("This lender has no submission email on file");
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function listProposedAction(): Promise<
  ActionResult<Awaited<ReturnType<typeof listProposed>>>
> {
  const session = await requireSession();
  try {
    return { ok: true, data: await db.withUser(session.userId, listProposed) };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** A manager confirms or rejects what the reader proposed. Money only ever lands through here. */
export async function decideProposedAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    if (!CAN.editOffers(session.role))
      throw new UserError("Only a manager can confirm lender updates");
    const i = z.object({ id, decision: z.enum(["apply", "reject"]) }).parse(input);
    await db.withUser(session.userId, async (q) => {
      if (i.decision === "apply") await q.query("select apply_proposed_update($1)", [i.id]);
      else
        await q.query(
          "update proposed_updates set status = 'rejected', decided_by = app.current_user_id(), decided_at = now() where id = $1",
          [i.id],
        );
    });
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
