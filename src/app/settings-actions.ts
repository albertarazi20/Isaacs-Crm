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
import {
  saveAiSettings,
  saveDocumentRetention,
  saveRegistration,
  saveShopSettings,
} from "@/lib/settings/mutations";
import { aiSchema, registrationSchema, retentionSchema, shopSchema } from "@/lib/settings/schemas";

const pct = z.coerce.number().min(0).max(100);

/** The shop-wide email and lender rules. One row; managers only (RLS enforces it too). */
export async function saveShopSettingsAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const i = shopSchema.parse(input);
    await db.withUser(session.userId, (q) => saveShopSettings(q, i));
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

export async function saveAiSettingsAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const i = aiSchema.parse(input);
    await db.withUser(session.userId, (q) => saveAiSettings(q, i));
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

/** How long a dead deal's documents are kept before the nightly purge (S3-9). Managers only. */
export async function saveDocumentRetentionAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const i = retentionSchema.parse(input);
    await db.withUser(session.userId, (q) => saveDocumentRetention(q, i));
    revalidatePath("/settings/plan");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/**
 * The shop's registration in a state: added, or its status, number and renewal date changed (0350). The rules table
 * beside it is the shop's lawyer's; this is only the shop's own side. Managers only (RLS enforces it too).
 */
export async function saveRegistrationAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const i = registrationSchema.parse(input);
    await db.withUser(session.userId, (q) => saveRegistration(q, i));
    revalidatePath("/settings/states");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
