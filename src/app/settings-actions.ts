"use server";

import { promises as dns } from "node:dns";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireRole } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { id } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { checkAutomationDns, describeDnsCheck, storeDnsCheck } from "@/lib/send/dns";

const pct = z.coerce.number().min(0).max(100);

const shopSchema = z.object({
  shopName: z.string().trim().min(1).max(80),
  postalAddress: z.string().trim().max(300).default(""),
  dailyCap: z.coerce.number().int().min(50).max(2000),
  amberAt: z.coerce.number().int().min(10).max(2000),
  reservedForIntake: z.coerce.number().int().min(0).max(500),
  sequencesEnabled: z.boolean(),
  sendWindowStart: z.coerce.number().int().min(0).max(23),
  sendWindowEnd: z.coerce.number().int().min(1).max(24),
  sendOnWeekends: z.boolean(),
  /** US federal holidays (S1-11); a form that does not send it leaves the window closed on them. */
  sendOnHolidays: z.boolean().default(false),
  perMerchantDaily: z.coerce.number().int().min(1).max(5),
  perMerchantWeekly: z.coerce.number().int().min(1).max(20),
  automationFrom: z.string().trim().max(200).default(""),
  automationReplyToRep: z.boolean(),
  lenderChaseDays: z.coerce.number().int().min(1).max(14),
  lenderChaseMode: z.enum(["send", "off"]),
  lenderChaseMax: z.coerce.number().int().min(0).max(5),
  maxLendersPerDeal: z.coerce.number().int().min(1).max(30),
});

/** The shop-wide email and lender rules. One row; managers only (RLS enforces it too). */
export async function saveShopSettingsAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const i = shopSchema.parse(input);
    await db.withUser(session.userId, (q) =>
      q.query(
        `update shop_settings set shop_name = $1, postal_address = $2, daily_cap = $3, amber_at = $4, reserved_for_intake = $5,
                sequences_enabled = $6, send_window_start = $7, send_window_end = $8, send_on_weekends = $9,
                per_merchant_daily = $10, per_merchant_weekly = $11, automation_from = $12, automation_reply_to_rep = $13,
                lender_chase_days = $14, lender_chase_mode = $15, lender_chase_max = $16, max_lenders_per_deal = $17,
                send_on_holidays = $18`,
        [
          i.shopName,
          i.postalAddress,
          i.dailyCap,
          i.amberAt,
          i.reservedForIntake,
          i.sequencesEnabled,
          i.sendWindowStart,
          i.sendWindowEnd,
          i.sendOnWeekends,
          i.perMerchantDaily,
          i.perMerchantWeekly,
          i.automationFrom,
          i.automationReplyToRep,
          i.lenderChaseDays,
          i.lenderChaseMode,
          i.lenderChaseMax,
          i.maxLendersPerDeal,
          i.sendOnHolidays,
        ],
      ),
    );
    revalidatePath("/", "layout");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/**
 * The DNS gate (S1-4): look up SPF, DKIM and DMARC for the automation address and store the result. The outbox worker
 * sends from the Resend domain only while the stored result says all three are there.
 */
export async function checkAutomationDnsAction(): Promise<
  ActionResult<{ ok: boolean; summary: string }>
> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const from = await db.withUser(
      session.userId,
      async (q) =>
        (await q.query<{ automation_from: string }>("select automation_from from shop_settings"))
          .rows[0]?.automation_from ?? "",
    );
    const check = await checkAutomationDns(from, { resolveTxt: (h) => dns.resolveTxt(h) });
    await db.withUser(session.userId, (q) => storeDnsCheck(q, check));
    revalidatePath("/settings/email");
    return { ok: true, data: { ok: check.ok, summary: describeDnsCheck(check) } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

const aiSchema = z.object({
  aiEnabled: z.boolean(),
  aiModel: z.string().trim().min(3).max(60),
  aiDailyCapCents: z.coerce.number().int().min(0).max(100_000),
  aiAutoApplyLowStakes: z.boolean(),
});

export async function saveAiSettingsAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const i = aiSchema.parse(input);
    await db.withUser(session.userId, (q) =>
      q.query(
        "update shop_settings set ai_enabled = $1, ai_model = $2, ai_daily_cap_cents = $3, ai_auto_apply_low_stakes = $4",
        [i.aiEnabled, i.aiModel, i.aiDailyCapCents, i.aiAutoApplyLowStakes],
      ),
    );
    revalidatePath("/settings/ai");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

const planSchema = z.object({
  userId: id.nullable().default(null),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  splitPct: pct,
  selfGenSplitPct: pct.nullable().default(null),
  psfSharePct: pct.default(0),
  renewalSplitPct: pct.nullable().default(null),
  tiers: z
    .array(z.object({ fromAmount: z.coerce.number().min(0), splitPct: pct }))
    .max(6)
    .default([]),
  managerOverridePct: pct.default(0),
  clawbackBorneBy: z.enum(["rep", "house", "split"]).default("rep"),
  note: z.string().trim().max(300).default(""),
});

/** A new plan row (plans are append-only by effective date, so history stays intact). */
export async function saveCommissionPlanAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const i = planSchema.parse(input);
    const tiers = i.tiers.map((t) => ({
      from_cents: Math.round(t.fromAmount * 100),
      split_pct: t.splitPct,
    }));
    const data = await db.withUser(session.userId, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `insert into commission_plans (user_id, effective_from, split_pct, self_gen_split_pct, psf_share_pct, renewal_split_pct, tiers, manager_override_pct, clawback_borne_by, note)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) returning id`,
        [
          i.userId,
          i.effectiveFrom,
          i.splitPct,
          i.selfGenSplitPct,
          i.psfSharePct,
          i.renewalSplitPct,
          JSON.stringify(tiers),
          i.managerOverridePct,
          i.clawbackBorneBy,
          i.note,
        ],
      );
      return rows[0]!;
    });
    revalidatePath("/settings/plan");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function deleteSuppressionAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const i = z.object({ suppressionId: id }).parse(input);
    await db.withUser(session.userId, (q) =>
      q.query("delete from suppressions where id = $1", [i.suppressionId]),
    );
    revalidatePath("/settings/email");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
