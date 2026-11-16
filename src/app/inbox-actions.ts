"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import { id, text } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { aiFailureWords, NO_KEY_WORDS } from "@/lib/deals/aiWords";
import { GmailReconnectError } from "@/lib/email/gmail";
import { env } from "@/lib/env";
import { sendChaseDraft } from "@/lib/inbox/chaseDrafts";
import { chaseLender, forwardToLender, submitToLenders } from "@/lib/inbox/submit";
import { importPastedOffer, type PastedOfferResult } from "@/lib/inbox/paste";
import { importOfferImage, type OfferImageResult } from "@/lib/inbox/pasteImage";
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
        {
          ...i,
          senderName: me?.name || session.email,
          senderEmail: me?.email ?? session.email,
          senderUserId: session.userId,
          appUrl: env().APP_URL,
        },
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

/** A manager undoes an applied AI update: the lender row goes back to what it was, with a timeline line (S2-9). */
export async function revertAiUpdateAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    if (!CAN.editOffers(session.role)) throw new UserError("Only a manager can undo an AI update");
    const i = z.object({ id }).parse(input);
    await db.withUser(session.userId, (q) => q.query("select revert_ai_update($1)", [i.id]));
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** A manager pastes a lender's portal page or email text; the terms land in the Review tray (S2-15). */
export async function importPastedOfferAction(
  input: unknown,
): Promise<ActionResult<PastedOfferResult>> {
  const session = await requireSession();
  try {
    if (!CAN.editOffers(session.role)) throw new UserError("Only a manager can import pasted text");
    if (!env().ANTHROPIC_API_KEY) throw new UserError(NO_KEY_WORDS);
    const i = z
      .object({ dealId: id, submissionId: id.nullable().default(null), text: text(20_000) })
      .parse(input);
    const data = await importPastedOffer({ db, userId: session.userId, input: i });
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: aiFailureWords(e) ?? toActionError(e) };
  }
}

/** Ops (or the rep) sends the checked documents to one lender: expiring watermarked links on the submission thread. */
export async function forwardDocumentsAction(
  input: unknown,
): Promise<ActionResult<{ links: number }>> {
  const session = await requireSession();
  try {
    const i = z
      .object({
        submissionId: id,
        documentIds: z.array(id).min(1).max(20),
        note: text(500).default(""),
      })
      .parse(input);
    const me = await db.withUser(
      session.userId,
      async (q) =>
        (
          await q.query<{ name: string }>(
            "select name from app_users where id = app.current_user_id()",
          )
        ).rows[0],
    );
    const r = await db.withUser(session.userId, (q) =>
      forwardToLender(q, {
        ...i,
        appUrl: env().APP_URL,
        senderName: me?.name || session.email,
        createdBy: session.userId,
        send: (m) => sendEmailAsUser(session.userId, m),
      }),
    );
    revalidatePath("/", "layout");
    return { ok: true, data: { links: r.links } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** A manager drops a screenshot of a lender's portal page; it is transcribed, read, and lands in the Review tray. */
export async function importOfferImageAction(
  form: FormData,
): Promise<ActionResult<OfferImageResult>> {
  const session = await requireSession();
  try {
    if (!CAN.editOffers(session.role))
      throw new UserError("Only a manager can import a screenshot");
    if (!env().ANTHROPIC_API_KEY) throw new UserError(NO_KEY_WORDS);
    const meta = z.object({ dealId: id, submissionId: id.nullable().default(null) }).parse({
      dealId: form.get("dealId"),
      submissionId: form.get("submissionId") || null,
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw new UserError("Attach the screenshot first");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = await importOfferImage({
      db,
      userId: session.userId,
      input: { ...meta, bytes, mediaType: file.type, filename: file.name },
    });
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: aiFailureWords(e) ?? toActionError(e) };
  }
}

/**
 * Ops (or a manager) sends a drafted chase on the lender's thread and clears the draft (S2-6, 'draft' mode). It goes
 * from the deal's rep's mailbox, like the automatic mode; when that mailbox is not connected the words say so and
 * the draft stays, to copy or dismiss.
 */
export async function sendChaseDraftAction(
  input: unknown,
): Promise<ActionResult<{ funderName: string }>> {
  const session = await requireSession();
  try {
    if (!CAN.runOps(session.role)) throw new UserError("Only ops or a manager can send a chase");
    const i = z.object({ alertId: z.string().regex(/^\d+$/) }).parse(input);
    const data = await db.withUser(session.userId, (q) =>
      sendChaseDraft(q, {
        alertId: i.alertId,
        sendFor: (userId) => (m) => sendEmailAsUser(userId, m),
      }),
    );
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    if (e instanceof GmailReconnectError)
      return {
        ok: false,
        error:
          "The rep's Gmail isn't connected, so the nudge can't go out on the thread. Copy it, or dismiss it.",
      };
    if (e instanceof Error && e.message === "Google is not configured")
      return {
        ok: false,
        error:
          "Google isn't set up on this server, so nothing can be sent from here. Copy the nudge instead.",
      };
    return { ok: false, error: toActionError(e) };
  }
}
