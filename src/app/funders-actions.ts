"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { userContext } from "@/lib/data/queries";
import type { ActionResult, UserContext } from "@/lib/data/types";
import { db, type Db } from "@/lib/db";
import * as m from "@/lib/funders/mutations";
import * as s from "@/lib/funders/schemas";

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

const nothing = async (p: Promise<unknown>): Promise<null> => {
  await p;
  return null;
};

export async function saveFunderAction(input: unknown): Promise<ActionResult<string>> {
  return run((q) => m.saveFunder(q, s.funderSchema.parse(input)));
}
export async function setFunderActiveAction(input: unknown): Promise<ActionResult<null>> {
  return run((q) => {
    const i = s.funderActiveSchema.parse(input);
    return nothing(m.setFunderActive(q, i.id, i.active));
  });
}
export async function deleteFunderAction(input: unknown): Promise<ActionResult<null>> {
  return run((q) => nothing(m.deleteFunder(q, s.funderIdSchema.parse(input).id)));
}

/** Returns how many submissions were created. */
export async function sendToFundersAction(input: unknown): Promise<ActionResult<number>> {
  return run((q) => m.sendToFunders(q, s.sendSchema.parse(input)));
}
export async function setSubmissionStatusAction(input: unknown): Promise<ActionResult<null>> {
  return run((q) => nothing(m.setSubmissionStatus(q, s.statusSchema.parse(input))));
}
export async function removeSubmissionAction(input: unknown): Promise<ActionResult<null>> {
  return run((q) => nothing(m.removeSubmission(q, s.submissionIdSchema.parse(input).submissionId)));
}

export async function recordOfferAction(input: unknown): Promise<ActionResult<string>> {
  return run((q) => m.recordOffer(q, s.offerSchema.parse(input)));
}
export async function acceptOfferAction(input: unknown): Promise<ActionResult<null>> {
  return run((q) => nothing(m.acceptOffer(q, s.offerIdSchema.parse(input).offerId)));
}
export async function setOfferStatusAction(input: unknown): Promise<ActionResult<null>> {
  return run((q) => {
    const i = s.offerStatusSchema.parse(input);
    return nothing(m.setOfferStatus(q, i.offerId, i.status));
  });
}
export async function removeOfferAction(input: unknown): Promise<ActionResult<null>> {
  return run((q) => nothing(m.removeOffer(q, s.offerIdSchema.parse(input).offerId)));
}
