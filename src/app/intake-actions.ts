"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { costCents } from "@/lib/ai/cost";
import {
  PROMPT_VERSION as SPLIT_PROMPT_VERSION,
  splitLeadLine,
  splitLeadText,
  type SplitResult,
} from "@/lib/ai/splitLeadLine";
import { CAN, requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { assistantRefusal, ASSISTANT_REFUSALS } from "@/lib/leads/assistant";
import { intakeLead, intakeSchema, type IntakeOutcome } from "@/lib/leads/form";
import { lookupLeadOwner, ownedElsewhereMessage } from "@/lib/leads/owner";
import { listStagedRows, type StagedRow } from "@/lib/leads/staged";

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
    if (!env().ANTHROPIC_API_KEY) throw new UserError(ASSISTANT_REFUSALS.notSetUp);
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
    if (!settings) throw new UserError(ASSISTANT_REFUSALS.off);
    const refusal = assistantRefusal({
      keySet: true,
      enabled: settings.ai_enabled,
      capCents: settings.ai_daily_cap_cents,
      spentCents: Number(settings.spent),
    });
    if (refusal) throw new UserError(refusal);
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

/** Another rep's merchant behind a phone or email, as the intake form's warning shows it. */
export interface LeadOwnerInfo {
  /** The server's words: "Already in the system: Mike's lead, in Missing statements, touched 3 days ago". */
  line: string;
  matchedOn: "phone" | "email";
  /** Only a manager is told which merchant it is (a rep's answer carries no more than the line). */
  clientId: string | null;
  businessName: string | null;
}

/**
 * Before submit: does another rep already own this phone or email? Row security hides their merchants from the form's
 * own duplicate check, so this asks across the shop (lead_owner) and answers with the same line the server refuses
 * with. A merchant that is the caller's own is not a cross-rep case and comes back as null. A manager may add the
 * lead anyway (`override` on the submit); a rep may not.
 */
export async function leadOwnerAction(
  input: unknown,
): Promise<ActionResult<{ owner: LeadOwnerInfo | null; canOverride: boolean }>> {
  const session = await requireSession();
  try {
    const i = z
      .object({ phone: z.string().max(40).default(""), email: z.string().max(200).default("") })
      .parse(input);
    const manager = CAN.manageTeam(session.role);
    const owner = await db.withUser(session.userId, (q) => lookupLeadOwner(q, i));
    if (!owner || owner.owner_id === session.userId)
      return { ok: true, data: { owner: null, canOverride: manager } };
    return {
      ok: true,
      data: {
        owner: {
          line: ownedElsewhereMessage(owner),
          matchedOn: owner.matched_on,
          clientId: manager ? owner.client_id : null,
          businessName: manager ? owner.business_name : null,
        },
        canOverride: manager,
      },
    };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/**
 * The intake form's submit. Created, filed from a sheet, or a duplicate (with the existing merchant) come back
 * as data; anything that stopped the merchant being made comes back as the error, in words, with nothing written.
 * `override` (managers only) adds the lead although the number is already in the CRM.
 */
export async function intakeLeadAction(input: unknown): Promise<ActionResult<IntakeOutcome>> {
  const session = await requireSession();
  try {
    const i = intakeSchema.parse(input);
    const { override } = z.object({ override: z.boolean().default(false) }).parse(input);
    if (override && !CAN.manageTeam(session.role))
      throw new UserError("Only a manager can add a lead another rep already has");
    const data = await db.withUser(session.userId, (q) =>
      intakeLead(q, i, env().APP_URL, new Date(), { allowDuplicate: override }),
    );
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** The sheet rows waiting to be filed, for the New lead sheet's "From your sheets" tab (read when it opens). */
export async function loadStagedRowsAction(): Promise<
  ActionResult<{ rows: StagedRow[]; total: number }>
> {
  const session = await requireSession();
  try {
    const data = await db.withUser(session.userId, (q) => listStagedRows(q));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
