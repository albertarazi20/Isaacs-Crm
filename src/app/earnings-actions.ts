"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { userContext } from "@/lib/data/queries";
import type { ActionResult, UserContext } from "@/lib/data/types";
import { db, type Db } from "@/lib/db";
import * as m from "@/lib/earnings/mutations";
import * as s from "@/lib/earnings/schemas";

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

/** Edit every term of an advance (and its commission). The renewal call follows, atomically, in the database. */
export async function updateFundingTermsAction(input: unknown): Promise<ActionResult<null>> {
  return run((q, ctx) => nothing(m.updateFundingTerms(q, s.termsUpdateSchema.parse(input), ctx)));
}

/** Record the commission the funder actually paid on an advance. */
export async function recordCommissionReceivedAction(input: unknown): Promise<ActionResult<null>> {
  return run((q) =>
    nothing(m.recordCommissionReceived(q, s.commissionReceivedSchema.parse(input))),
  );
}
