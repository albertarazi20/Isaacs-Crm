"use server";

import { promises as dns } from "node:dns";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireRole } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { id } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import {
  checkAutomationDns,
  describeDnsCheck,
  DnsUnreachableError,
  storeDnsCheck,
} from "@/lib/send/dns";
import { removeSuppression, saveAiSettings, saveShopSettings } from "@/lib/settings/mutations";
import { aiSchema, shopSchema } from "@/lib/settings/schemas";

/** The shop-wide email rules. One row; managers only (RLS enforces it too). */
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
    if (e instanceof DnsUnreachableError) return { ok: false, error: e.message };
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

export async function deleteSuppressionAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireRole(CAN.manageTeam);
  try {
    const i = z.object({ suppressionId: id }).parse(input);
    await db.withUser(session.userId, (q) => removeSuppression(q, i.suppressionId));
    revalidatePath("/settings/email");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
