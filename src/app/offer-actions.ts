"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import type { ActionResult } from "@/lib/data/types";
import { UserError } from "@/lib/data/mutations";
import { db } from "@/lib/db";
import { documentStore } from "@/lib/docs/storage";
import { env } from "@/lib/env";
import { createOffer, withdrawOffer, type MadeOffer } from "@/lib/offers/mutations";
import { offerSchema } from "@/lib/offers/terms";
import { notifyOfferAccepted, productionNoticeSenders } from "@/lib/system/offerNotice";

/** Make an offer (and email it unless the rep chose to send the link themselves). */
export async function createOfferAction(input: unknown): Promise<ActionResult<MadeOffer>> {
  const session = await requireSession();
  try {
    const i = offerSchema.parse(input);
    const made = await db.withUser(session.userId, (q) =>
      createOffer(q, i, { userId: session.userId, now: new Date(), appUrl: env().APP_URL }),
    );
    revalidatePath(`/clients/${i.clientId}`);
    revalidatePath("/approvals");
    return { ok: true, data: made };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function withdrawOfferAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const { offerId, clientId } = z
      .object({ offerId: z.string().uuid(), clientId: z.string().uuid() })
      .parse(input);
    await db.withUser(session.userId, (q) =>
      withdrawOffer(q, offerId, { userId: session.userId, now: new Date(), appUrl: env().APP_URL }),
    );
    revalidatePath(`/clients/${clientId}`);
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Try the rep's copy of an accepted offer again (after connecting Gmail, say). */
export async function resendOfferNoticeAction(
  input: unknown,
): Promise<ActionResult<{ sent: boolean; error?: string }>> {
  const session = await requireSession();
  try {
    const { offerId, clientId } = z
      .object({ offerId: z.string().uuid(), clientId: z.string().uuid() })
      .parse(input);
    // row security: only someone who can see the merchant can ask
    const seen = await db.withUser(session.userId, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        "select id from merchant_offers where id = $1 and status = 'accepted' and accept_notified_at is null",
        [offerId],
      );
      return rows[0];
    });
    if (!seen) throw new UserError("That copy was already sent, or the offer isn't accepted");
    const e = env();
    const r = await notifyOfferAccepted(offerId, {
      store: documentStore(e),
      senders: productionNoticeSenders(),
      appUrl: e.APP_URL,
    });
    revalidatePath(`/clients/${clientId}`);
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
