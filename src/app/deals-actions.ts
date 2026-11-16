"use server";

import { revalidatePath } from "next/cache";
import { CAN, requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import type { ActionResult } from "@/lib/data/types";
import { db, type Db } from "@/lib/db";
import { UserError } from "@/lib/data/mutations";
import * as m from "@/lib/deals/mutations";
import * as s from "@/lib/deals/schemas";
import type { Role } from "@/lib/auth/roles";

async function run<T>(
  fn: (q: Db) => Promise<T>,
  allowed: (r: Role) => boolean = () => true,
): Promise<ActionResult<T>> {
  const session = await requireSession();
  try {
    if (!allowed(session.role)) throw new UserError("Your account can't do that");
    const data = await db.withUser(session.userId, fn);
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function submitToOpsAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return run(
    async (q) => ({ id: (await m.submitToOps(q, s.submitToOpsSchema.parse(input))).id }),
    CAN.workLeads,
  );
}

export async function kickBackDealAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.kickBack(q, s.kickBackSchema.parse(input));
    return null;
  }, CAN.runOps);
}

export async function markDealSentAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.markSent(q, s.dealIdSchema.parse(input).dealId);
    return null;
  }, CAN.runOps);
}

export async function closeDealAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    await m.closeDeal(q, s.closeDealSchema.parse(input));
    return null;
  });
}

export async function setDealNoteAction(input: unknown): Promise<ActionResult<null>> {
  return run(async (q) => {
    const i = s.dealNoteSchema.parse(input);
    return (await m.setDealNote(q, i), null);
  });
}
