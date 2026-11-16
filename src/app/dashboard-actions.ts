"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireRole } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { id, money } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { setGoal } from "@/lib/dashboard/queries";
import { db } from "@/lib/db";

const goalSchema = z.object({
  userId: id.nullable().default(null),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  fundedAmount: money,
  deals: z.coerce.number().int().min(0).max(1000).default(0),
});

/** Managers set the month's goal for the shop (userId null) or one rep. */
export async function setGoalAction(input: unknown): Promise<ActionResult<null>> {
  try {
    const session = await requireRole(CAN.manageTeam);
    const g = goalSchema.parse(input);
    await db.withUser(session.userId, (q) =>
      setGoal(
        q,
        { userId: g.userId, month: g.month, fundedCents: g.fundedAmount, deals: g.deals },
        session.userId,
      ),
    );
    revalidatePath("/");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
