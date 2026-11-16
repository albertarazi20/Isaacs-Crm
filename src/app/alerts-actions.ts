"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { markAlertsRead } from "@/lib/alerts/feed";

const schema = z.object({ ids: z.array(z.string().regex(/^\d+$/)).max(500).optional() });

/** Marks alerts read: the given ones, or all of the person's unread ones. */
export async function markAlertsReadAction(input: unknown): Promise<ActionResult<{ n: number }>> {
  const session = await requireSession();
  try {
    const { ids } = schema.parse(input ?? {});
    const n = await db.withUser(session.userId, (q) => markAlertsRead(q, ids));
    revalidatePath("/", "layout");
    return { ok: true, data: { n } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
