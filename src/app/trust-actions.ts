"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireRole, requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { id } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import {
  ACCESS_ACTIONS,
  accessHistory,
  createCanary,
  exposureReport,
  logAccess,
  offboardUser,
  trustPanel,
  type AccessLine,
  type Exposure,
  type OffboardReport,
  type TrustRow,
} from "@/lib/trust/queries";

async function requestMeta(): Promise<{ ip: string; userAgent: string }> {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "",
    userAgent: h.get("user-agent") ?? "",
  };
}

/** Every copy / reveal button calls this. Cheap, fire-and-forget from the client, never blocks the UI. */
export async function logAccessAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const i = z
      .object({
        action: z.enum(ACCESS_ACTIONS),
        clientId: id.nullable().default(null),
        documentId: id.nullable().default(null),
        detail: z.string().trim().max(300).default(""),
      })
      .parse(input);
    const meta = await requestMeta();
    await db.withUser(session.userId, (q) =>
      logAccess(q, { userId: session.userId, ...i, ...meta }),
    );
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function trustPanelAction(input: unknown): Promise<ActionResult<TrustRow[]>> {
  try {
    const session = await requireRole(CAN.manageTeam);
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
      .parse(input ?? {});
    const data = await db.withUser(session.userId, (q) => trustPanel(q, days));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function exposureReportAction(input: unknown): Promise<ActionResult<Exposure>> {
  try {
    const session = await requireRole(CAN.manageTeam);
    const { clientId } = z.object({ clientId: id }).parse(input);
    const data = await db.withUser(session.userId, (q) => exposureReport(q, clientId));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function accessHistoryAction(input: unknown): Promise<ActionResult<AccessLine[]>> {
  try {
    const session = await requireRole(CAN.manageTeam);
    const i = z
      .object({ userId: id, days: z.coerce.number().int().min(1).max(365).default(30) })
      .parse(input);
    const data = await db.withUser(session.userId, (q) => accessHistory(q, i.userId, i.days));
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function createCanaryAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await requireRole(CAN.manageTeam);
    const i = z
      .object({
        repId: id,
        business: z.string().trim().min(2).max(120),
        contact: z.string().trim().max(80).default(""),
        phone: z.string().trim().min(7).max(20),
        email: z.string().trim().email(),
      })
      .parse(input);
    const canaryId = await db.withUser(session.userId, (q) => createCanary(q, i));
    revalidatePath("/", "layout");
    return { ok: true, data: { id: canaryId } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** Disable the login, cut the mailbox, move the book, return the 30-day report. One click, one transaction. */
export async function offboardUserAction(input: unknown): Promise<ActionResult<OffboardReport>> {
  try {
    const session = await requireRole(CAN.manageTeam);
    const i = z.object({ userId: id, reassignTo: id }).parse(input);
    const data = await db.withUser(session.userId, (q) => offboardUser(q, i.userId, i.reassignTo));
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
