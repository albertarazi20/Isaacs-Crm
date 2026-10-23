"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import {
  bulkReschedule,
  clientDirectory,
  snoozeWithReason,
  type BulkResult,
  type DirectoryRow,
} from "@/lib/data/overdue";
import { MAX_BULK_DAYS } from "@/lib/data/priority";
import { userContext } from "@/lib/data/queries";
import type { ActionResult, ClientCard, UserContext } from "@/lib/data/types";
import { db, type Db } from "@/lib/db";

/** Same shape as `run()` in actions.ts. Reads (`refresh: false`) leave the page alone. */
async function run<T>(
  fn: (q: Db, ctx: UserContext) => Promise<T>,
  refresh = true,
): Promise<ActionResult<T>> {
  const session = await requireSession();
  try {
    const data = await db.withUser(session.userId, async (q) => fn(q, await userContext(q)));
    if (refresh) revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

const bulkSchema = z.object({
  days: z.number().int().min(1).max(MAX_BULK_DAYS),
  keepUnderwriting: z.boolean(),
  hotIds: z.array(z.string().uuid()).max(1000).optional(),
});

/**
 * "Reschedule all overdue": spread the overdue pile over the next few business days, biggest deals first.
 * One transaction through the existing set_follow_up() function, so it is all or nothing.
 */
export async function bulkRescheduleAction(input: unknown): Promise<ActionResult<BulkResult>> {
  return run((q, ctx) => bulkReschedule(q, ctx, bulkSchema.parse(input)));
}

const snoozeSchema = z.object({
  clientId: z.string().uuid(),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date"),
  reason: z
    .string()
    .trim()
    .max(300, "Keep the reason to one line")
    .regex(/^[^\p{Cc}]*$/u, "The reason can't contain line breaks"),
});

/** Snooze a live deal and say why, in one transaction: the reason lands on the timeline as a note. */
export async function snoozeWithReasonAction(input: unknown): Promise<ActionResult<ClientCard>> {
  return run((q, ctx) => snoozeWithReason(q, ctx, snoozeSchema.parse(input)));
}

/** The lightweight client list behind search and inbound-call lookup. Fetched when the palette first opens. */
export async function loadDirectoryAction(): Promise<ActionResult<DirectoryRow[]>> {
  return run((q) => clientDirectory(q), false);
}
