"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { costCents } from "@/lib/ai/readLenderEmail";
import {
  PROMPT_VERSION as SPLIT_PROMPT_VERSION,
  splitLeadLine,
  splitLeadText,
  type SplitResult,
} from "@/lib/ai/splitLeadLine";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { intakeLead, intakeSchema, type IntakeOutcome } from "@/lib/leads/form";

export type { IntakeOutcome } from "@/lib/leads/form";

/**
 * Paste a lead line (S1-12): Claude splits the text into the form's fields; a phone or email that is not in the
 * text is refused. The AI kill switch and the daily spend cap apply; every call is logged in ai_runs.
 */
export async function splitLeadLineAction(
  input: unknown,
): Promise<ActionResult<{ fields: SplitResult }>> {
  const session = await requireSession();
  try {
    const { text } = z.object({ text: z.string().max(4_000) }).parse(input);
    if (!env().ANTHROPIC_API_KEY) throw new UserError("The assistant is not set up on this server");
    const settings = await db.withUser(
      session.userId,
      async (q) =>
        (
          await q.query<{
            ai_enabled: boolean;
            ai_model: string;
            ai_daily_cap_cents: number;
            spent: string;
          }>(
            "select ai_enabled, ai_model, ai_daily_cap_cents, app.ai_spent_today_cents()::text as spent from shop_settings",
          )
        ).rows[0],
    );
    if (!settings?.ai_enabled) throw new UserError("The assistant is switched off in Settings");
    if (Number(settings.spent) >= settings.ai_daily_cap_cents)
      throw new UserError("The assistant has used today's budget — type the lead in by hand");
    const { fields, outcome } = await splitLeadText(
      text,
      (t, model) => splitLeadLine(t, { model }),
      settings.ai_model,
    );
    await db.withUser(session.userId, (q) =>
      q.query("select app.log_ai_run('split_lead_line', $1, $2, $3, $4, $5, $6, $7::jsonb, null)", [
        outcome.model,
        SPLIT_PROMPT_VERSION,
        outcome.inputHash,
        outcome.inputTokens,
        outcome.outputTokens,
        costCents(outcome.model, outcome.inputTokens, outcome.outputTokens),
        JSON.stringify(outcome.result),
      ]),
    );
    return { ok: true, data: { fields } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

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
