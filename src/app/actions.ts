"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";
import { getSession, requireSession } from "@/lib/auth/server";
import { db, type Db } from "@/lib/db";
import { GmailReconnectError } from "@/lib/email/gmail";
import { toActionError } from "@/lib/data/errors";
import {
  checkImportRows,
  importRawRows,
  type ImportCheck,
  type ImportResult,
} from "@/lib/data/import";
import { mergeSources } from "@/lib/data/sources";
import * as m from "@/lib/data/mutations";
import { findDuplicates, listSources, userContext, type DuplicateMatch } from "@/lib/data/queries";
import * as s from "@/lib/data/schemas";
import type { ActionResult, ClientCard, UserContext } from "@/lib/data/types";
import { env } from "@/lib/env";
import { suggestAfterEmail } from "@/lib/mca/touch";
import { refuseAnotherRepsOnEdit } from "@/lib/leads/editOwner";
import { refuseAnotherReps } from "@/lib/leads/owner";
import { sendViaResend } from "@/lib/email/resend";
import { disconnectGmail, sendEmailAsUser } from "@/lib/system/gmail";
import { recordAuditHere } from "@/lib/system/audit";
import { endAllSessions, endSession } from "@/lib/system/sessions";
import { bumpSessionEpoch } from "@/lib/system/users";
import { sendTestDigest } from "@/lib/system/reminders";

/** `refresh: false` for read-only lookups, so they don't re-render the page behind the dialog. */
async function run<T>(
  fn: (q: Db, ctx: UserContext) => Promise<T>,
  refresh = true,
): Promise<ActionResult<T>> {
  const session = await requireSession();
  try {
    const data = await db.withUser(session.userId, async (q) => fn(q, await userContext(q)));
    if (refresh) revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

type Card = ClientCard;

export async function findDuplicatesAction(
  input: unknown,
): Promise<ActionResult<DuplicateMatch[]>> {
  return run((q) => findDuplicates(q, s.duplicateCheckSchema.parse(input)), false);
}
export async function addClientAction(input: unknown): Promise<ActionResult<Card>> {
  return run(async (q, ctx) => {
    const client = s.newClientSchema.parse(input);
    // another rep's merchant is invisible to the rep's own duplicate check: ask across the shop and refuse in words
    await refuseAnotherReps(q, { phone: client.phone, email: client.email });
    return m.createClient(q, client, ctx);
  });
}
export async function mergeClientsAction(input: unknown): Promise<ActionResult<Card>> {
  return run((q) => m.mergeClients(q, s.mergeSchema.parse(input)));
}
export async function moveClientAction(input: unknown): Promise<ActionResult<Card>> {
  return run((q, ctx) => m.moveClient(q, s.moveSchema.parse(input), ctx));
}
export async function setFollowUpAction(input: unknown): Promise<ActionResult<Card>> {
  return run((q, ctx) => m.setFollowUp(q, s.followUpSchema.parse(input), ctx));
}
export async function moveToBucketAction(input: unknown): Promise<ActionResult<Card>> {
  return run((q, ctx) => m.moveToBucket(q, s.bucketSchema.parse(input), ctx));
}
export async function logTouchAction(input: unknown): Promise<ActionResult<Card>> {
  return run((q, ctx) => m.logTouch(q, s.touchSchema.parse(input), ctx));
}
export async function scheduleCallAction(input: unknown): Promise<ActionResult<Card>> {
  return run((q, ctx) => m.scheduleCall(q, s.scheduleCallSchema.parse(input), ctx));
}
export async function setContactStatusAction(input: unknown): Promise<ActionResult<Card>> {
  return run((q) => m.setContactStatus(q, s.contactStatusSchema.parse(input)));
}
export async function cancelCallAction(input: unknown): Promise<ActionResult<Card>> {
  return run((q) => m.cancelCall(q, s.clientIdSchema.parse(input).clientId));
}
export async function addNoteAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.addNote(q, s.noteSchema.parse(input));
    return null;
  });
}
export async function updateClientAction(input: unknown): Promise<ActionResult<Card>> {
  return run(async (q) => {
    const parsed = s.updateClientSchema.parse(input);
    // a phone or email moved onto another rep's merchant would make two reps chase one merchant
    await refuseAnotherRepsOnEdit(q, parsed.clientId, parsed.fields);
    return m.updateClient(q, parsed);
  });
}
export async function listSourcesAction(): Promise<ActionResult<string[]>> {
  return run(async (q) => mergeSources(await listSources(q)), false);
}
export async function trashClientAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.trashClient(q, s.clientIdSchema.parse(input).clientId);
    return null;
  });
}
export async function restoreClientAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.restoreClient(q, s.clientIdSchema.parse(input).clientId);
    return null;
  });
}
export async function purgeClientAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.purgeClient(q, s.clientIdSchema.parse(input).clientId);
    return null;
  });
}
export async function seedStipsAction(input: unknown): Promise<ActionResult<number>> {
  return run((q, ctx) => m.seedStips(q, s.clientIdSchema.parse(input).clientId, ctx));
}
export async function setStipAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.setStip(q, s.stipSchema.parse(input));
    return null;
  });
}
/** Review before import: which rows are already in the person's CRM (or do-not-contact), under row security. */
export async function checkImportAction(input: unknown): Promise<ActionResult<ImportCheck>> {
  return run((q) => checkImportRows(q, s.importCheckSchema.parse(input).rows), false);
}
export async function importClientsAction(input: unknown): Promise<ActionResult<ImportResult>> {
  return run((q, ctx) => importRawRows(q, input, ctx));
}
export async function updateSettingsAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.updateSettings(q, s.settingsSchema.parse(input));
    return null;
  });
}

/** Send from Isaac's own Gmail, then log it as a touch so the timer resets. */
export async function sendEmailAction(input: unknown): Promise<ActionResult<Card>> {
  const session = await requireSession();
  try {
    const i = s.emailSchema.parse(input);
    const client = await db.withUser(session.userId, (q) =>
      m.assertContactAllowed(q, i.clientId, "email"),
    );
    if (!client.email.trim()) throw new m.UserError("This merchant has no email address yet");
    // everything that can refuse the follow-up date is checked BEFORE the mail goes out: a failure after the
    // send would show an error for a mail that was sent, and the rep would send it twice
    const nextDueOn = await db.withUser(session.userId, async (q) => {
      await m.assertEmailQuota(q);
      const ctx = await userContext(q);
      const next = i.nextDueOn ?? suggestAfterEmail(ctx.today, client.stage);
      m.checkDate(next, ctx.today);
      return next;
    });
    try {
      await sendEmailAsUser(session.userId, {
        to: client.email.trim(),
        subject: i.subject,
        text: i.body,
      });
    } catch (e) {
      if (e instanceof GmailReconnectError) return { ok: false, error: e.message, reconnect: true };
      throw e;
    }
    let card: Card;
    try {
      card = await db.withUser(session.userId, async (q) =>
        m.logTouch(
          q,
          s.touchSchema.parse({
            clientId: i.clientId,
            kind: "email",
            outcome: null,
            body: `${i.subject}\n\n${i.body}`,
            nextDueOn,
          }),
          await userContext(q),
        ),
      );
    } catch (e) {
      console.error("email sent but not logged:", e);
      return {
        ok: false,
        error: "The email was sent, but it could not be logged on the card. Do not send it again.",
      };
    }
    revalidatePath("/", "layout");
    return { ok: true, data: card };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function disconnectGmailAction(): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    await disconnectGmail(session.userId);
    await recordAuditHere({
      kind: "gmail_disconnected",
      userId: session.userId,
      email: session.email,
    });
    revalidatePath("/settings");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Sends the real digest (or a sample) to the notification address right now. */
const lastTestEmail = new Map<string, number>();

export async function sendTestReminderAction(): Promise<
  ActionResult<{ to: string; usedSample: boolean; count: number }>
> {
  const session = await requireSession();
  const e = env();
  const last = lastTestEmail.get(session.userId) ?? 0;
  if (Date.now() - last < 60_000)
    return { ok: false, error: "Wait a minute before sending another test email" };
  lastTestEmail.set(session.userId, Date.now());
  if (!e.RESEND_API_KEY || !e.RESEND_FROM) {
    return {
      ok: false,
      error: "Reminder emails aren't set up yet. Add RESEND_API_KEY and RESEND_FROM on the server",
    };
  }
  const cfg = { apiKey: e.RESEND_API_KEY, from: e.RESEND_FROM };
  try {
    const data = await sendTestDigest({
      db,
      userId: session.userId,
      now: new Date(),
      appUrl: e.APP_URL,
      send: (to, d) => sendViaResend(cfg, { to, ...d }),
    });
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error && /^Resend failed/.test(err.message)
          ? err.message
          : toActionError(err),
    };
  }
}

/** Ends every session this user has, on every device — for a lost phone. */
export async function logoutEverywhereAction(): Promise<void> {
  const session = await requireSession();
  await bumpSessionEpoch(session.userId);
  // the epoch already refuses every old cookie; the rows go too, so nothing is left to roll or sweep
  await endAllSessions(session.userId);
  await recordAuditHere({
    kind: "signout_everywhere",
    userId: session.userId,
    email: session.email,
  });
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

export async function logoutAction(): Promise<void> {
  // no redirect to the sign-in page when the cookie is already dead: there is just nobody to record
  const session = await getSession();
  if (session)
    await recordAuditHere({ kind: "signout", userId: session.userId, email: session.email });
  // Clearing the browser's cookie is not enough: a copy of it must stop working too, so the sign-in's row goes. Read
  // from the cookie itself (genuine signature) rather than the session, so a session that is refused for another
  // reason is cleaned up as well.
  const store = await cookies();
  const own = await verifySession(store.get(SESSION_COOKIE)?.value, env().SESSION_SECRET);
  if (own?.sid) await endSession(own.sid, own.userId);
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
