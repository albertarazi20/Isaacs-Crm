"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { requireSession } from "@/lib/auth/server";
import { db, type Db } from "@/lib/db";
import { GmailReconnectError } from "@/lib/email/gmail";
import { toActionError } from "@/lib/data/errors";
import * as m from "@/lib/data/mutations";
import { getCard, userContext } from "@/lib/data/queries";
import * as s from "@/lib/data/schemas";
import type { ActionResult, ClientCard, UserContext } from "@/lib/data/types";
import { disconnectGmail, sendEmailAsUser } from "@/lib/system/gmail";

async function run<T>(fn: (q: Db, ctx: UserContext) => Promise<T>): Promise<ActionResult<T>> {
  const session = await requireSession();
  try {
    const data = await db.withUser(session.userId, async (q) => fn(q, await userContext(q)));
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

type Card = ClientCard;

export async function addClientAction(input: unknown): Promise<ActionResult<Card>> {
  return run((q, ctx) => m.createClient(q, s.newClientSchema.parse(input), ctx));
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
export async function addNoteAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.addNote(q, s.noteSchema.parse(input));
    return null;
  });
}
export async function updateClientAction(input: unknown): Promise<ActionResult<Card>> {
  return run((q) => m.updateClient(q, s.updateClientSchema.parse(input)));
}
export async function deleteClientAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.deleteClient(q, s.clientIdSchema.parse(input).clientId);
    return null;
  });
}
export async function saveAskAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.saveAsk(q, s.askSchema.parse(input));
    return null;
  });
}
export async function savePositionAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.savePosition(q, s.positionSchema.parse(input));
    return null;
  });
}
export async function deletePositionAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.deletePosition(q, s.idSchema.parse(input).id);
    return null;
  });
}
export async function saveOfferAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.saveOffer(q, s.offerSchema.parse(input));
    return null;
  });
}
export async function deleteOfferAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.deleteOffer(q, s.idSchema.parse(input).id);
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
export async function updateFundingAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q, ctx) => {
    await m.updateFunding(q, s.fundingUpdateSchema.parse(input), ctx);
    return null;
  });
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
    const client = await db.withUser(session.userId, (q) => getCard(q, i.clientId));
    if (!client) throw new m.UserError("That client no longer exists");
    if (!client.email.trim()) throw new m.UserError("This client has no email address yet");
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
    const card = await db.withUser(session.userId, async (q) =>
      m.logTouch(
        q,
        s.touchSchema.parse({
          clientId: i.clientId,
          kind: "email",
          outcome: null,
          body: `${i.subject}\n\n${i.body}`,
          nextDueOn: i.nextDueOn,
        }),
        await userContext(q),
      ),
    );
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
    revalidatePath("/settings");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
