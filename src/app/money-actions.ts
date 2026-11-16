"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import { userContext } from "@/lib/data/queries";
import { id, money } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import {
  confirmFunding,
  fundSchema,
  previewFund,
  proposeFunding,
  recordCommissionPaid,
  type FundPreview,
} from "@/lib/money/fund";

export async function previewFundAction(
  input: unknown,
): Promise<ActionResult<FundPreview & { checklist: unknown }>> {
  const session = await requireSession();
  try {
    const i = fundSchema.parse(input);
    const data = await db.withUser(session.userId, async (q) => {
      const ctx = await userContext(q);
      const preview = await previewFund(q, i, session.userId, ctx.today);
      const checklist = (
        await q.query<{ c: unknown }>("select fund_checklist($1) as c", [i.clientId])
      ).rows[0]?.c;
      return { ...preview, checklist };
    });
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** The rep (or manager) proposes the funded terms. A manager confirms in a second step. */
export async function proposeFundingAction(
  input: unknown,
): Promise<ActionResult<{ fundingId: string; confirmed: boolean }>> {
  const session = await requireSession();
  try {
    const i = fundSchema.parse(input);
    const data = await db.withUser(session.userId, async (q) => {
      const ctx = await userContext(q);
      const fundingId = await proposeFunding(q, i, ctx.today);
      // a manager funding a deal confirms it in the same click
      if (CAN.confirmFunding(session.role)) {
        await confirmFunding(q, fundingId);
        return { fundingId, confirmed: true };
      }
      return { fundingId, confirmed: false };
    });
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function confirmFundingAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    if (!CAN.confirmFunding(session.role))
      throw new UserError("Only a manager can confirm a funding");
    const { fundingId } = z.object({ fundingId: id }).parse(input);
    await db.withUser(session.userId, (q) => confirmFunding(q, fundingId));
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function recordCommissionPaidAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    if (!CAN.confirmFunding(session.role))
      throw new UserError("Only a manager can record a commission payment");
    const i = z
      .object({
        fundingId: id,
        amount: money,
        // a cleared date box sends ""; blank means today
        on: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .or(z.literal("").transform(() => undefined))
          .optional(),
        note: z.string().max(500).default(""),
      })
      .parse(input);
    await db.withUser(session.userId, (q) =>
      recordCommissionPaid(q, { fundingId: i.fundingId, cents: i.amount, on: i.on, note: i.note }),
    );
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
