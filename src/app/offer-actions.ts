"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { createOffer, withdrawOffer, type MadeOffer } from "@/lib/offers/mutations";
import { offerSchema } from "@/lib/offers/terms";

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
