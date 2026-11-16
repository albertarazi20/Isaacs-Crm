"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import { userContext } from "@/lib/data/queries";
import { id, line, money } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { closeMonth } from "@/lib/money/close";
import {
  confirmFunding,
  correctFunding,
  correctionSchema,
  fundSchema,
  previewFund,
  proposeFunding,
  recordCommissionPaid,
  type FundPreview,
} from "@/lib/money/fund";
import { startRenewal } from "@/lib/money/renewals";
import { reviewWinbackOpener, setWinbackReason } from "@/lib/money/winback";

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

// ---------- stream 3: corrections, the close, renewals, win-back answers ----------

/** A manager corrects a confirmed funding: original kept, difference posted as a dated correction line. */
export async function correctFundingAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    if (!CAN.confirmFunding(session.role))
      throw new UserError("Only a manager can correct a confirmed funding");
    const i = correctionSchema.parse(input);
    await db.withUser(session.userId, (q) => correctFunding(q, i));
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Close a past month by hand (the job does it on the 1st). Idempotent. */
export async function closeMonthAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    if (!CAN.confirmFunding(session.role)) throw new UserError("Only a manager can close a month");
    const { period } = z
      .object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })
      .parse(input);
    await db.withUser(session.userId, (q) => closeMonth(q, `${period}-01`));
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Opens the renewal deal pre-filled from the funding and asks the merchant for the newest statement. */
export async function startRenewalAction(
  input: unknown,
): Promise<ActionResult<{ dealId: string; number: number }>> {
  const session = await requireSession();
  try {
    const { fundingId } = z.object({ fundingId: id }).parse(input);
    const d = await db.withUser(session.userId, (q) => startRenewal(q, fundingId));
    revalidatePath("/", "layout");
    return { ok: true, data: { dealId: d.id, number: d.number } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** The win-back pick-list: why the deal never funded. */
export async function setWinbackReasonAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const i = z
      .object({
        memberId: id,
        reason: z.string().trim().min(1).max(40),
        note: line(300).default(""),
      })
      .parse(input);
    await db.withUser(session.userId, (q) => setWinbackReason(q, i));
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Review mode: a manager approves (edited or not) or rejects the drafted first line. */
export async function reviewWinbackOpenerAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    if (!CAN.confirmFunding(session.role))
      throw new UserError("Only a manager can approve a win-back opener");
    const i = z
      .object({ memberId: id, text: z.string().trim().max(300).default(""), approve: z.boolean() })
      .parse(input);
    await db.withUser(session.userId, (q) => reviewWinbackOpener(q, i));
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
