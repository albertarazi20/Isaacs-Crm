"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { id } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { handOff, undoHandOff } from "@/lib/followup/handoff";

const schema = z.object({ clientId: id });

/** "Hand off": the merchant is brought in, the chase stops, the managers hear once. */
export async function handOffAction(
  input: unknown,
): Promise<ActionResult<{ broughtInAt: string }>> {
  const session = await requireSession();
  try {
    const { clientId } = schema.parse(input);
    const broughtInAt = await db.withUser(session.userId, (q) => handOff(q, clientId));
    revalidatePath("/", "layout");
    return { ok: true, data: { broughtInAt } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Takes a hand-off back; `undone` is the hand-off time that was cleared (null when there was none). */
export async function undoHandOffAction(
  input: unknown,
): Promise<ActionResult<{ undone: string | null }>> {
  const session = await requireSession();
  try {
    const { clientId } = schema.parse(input);
    const undone = await db.withUser(session.userId, (q) => undoHandOff(q, clientId));
    revalidatePath("/", "layout");
    return { ok: true, data: { undone } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
