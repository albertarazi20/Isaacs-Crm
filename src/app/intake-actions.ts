"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { intakeLead, intakeSchema, type IntakeOutcome } from "@/lib/leads/form";

export type { IntakeOutcome } from "@/lib/leads/form";

/**
 * The intake form's submit. Created, filed from a sheet, or a duplicate (with the existing merchant) come back
 * as data; anything that stopped the merchant being made comes back as the error, in words, with nothing written.
 */
export async function intakeLeadAction(input: unknown): Promise<ActionResult<IntakeOutcome>> {
  const session = await requireSession();
  try {
    const i = intakeSchema.parse(input);
    const data = await db.withUser(session.userId, (q) => intakeLead(q, i, env().APP_URL));
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
