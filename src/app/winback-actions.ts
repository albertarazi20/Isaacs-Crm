"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { id } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";

/** Stop or restart one win-back member. Replies and fundings move them on their own. */
export async function setWinbackStatusAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const i = z
      .object({
        memberId: id,
        status: z.enum(["active", "stopped"]),
        reason: z.string().trim().max(200).default(""),
      })
      .parse(input);
    await db.withUser(session.userId, (q) =>
      q.query(
        `update winback_members set status = $2, stop_reason = case when $2 = 'stopped' then nullif($3, '') else null end,
                next_due_on = case when $2 = 'active' then greatest(workable_on, current_date) else next_due_on end
          where id = $1`,
        [i.memberId, i.status, i.reason],
      ),
    );
    revalidatePath("/winback");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
