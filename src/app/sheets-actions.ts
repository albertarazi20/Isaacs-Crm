"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import { id } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db, type Db } from "@/lib/db";
import { fileOneRow, PENDING_ROW_COLUMNS, type PendingRow } from "@/lib/sheets/file";
import {
  connectSheet,
  connectSheetSchema,
  updateSheetSchema,
  updateSheetSource,
} from "@/lib/sheets/sources";
import { productionTokenFor, syncSheets } from "@/lib/sheets/sync";
import { env } from "@/lib/env";

/** Connect a sheet: the link is checked against Google right away, so a bad share shows up now, not at 3am. */
export async function connectSheetAction(
  input: unknown,
): Promise<ActionResult<{ id: string; tabs: string[] }>> {
  const session = await requireSession();
  try {
    const i = connectSheetSchema.parse(input);
    if (i.shared && !CAN.manageTeam(session.role))
      throw new UserError("Only a manager can share a sheet with everyone");
    const data = await connectSheet({
      db,
      userId: session.userId,
      input: i,
      tokenFor: productionTokenFor(),
    });
    revalidatePath("/settings");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/**
 * The sync runs on the owner connection with the sheet reader's Google token, so the caller must be able to see
 * the sheet under row security first (P2-32): a stranger's sheet id gets "not found", never a Google read.
 */
async function assertSheetVisible(q: Db, sourceId: string): Promise<void> {
  const r = await q.query("select 1 from sheet_sources where id = $1", [sourceId]);
  if (r.rowCount === 0) throw new UserError("That sheet isn't yours to sync");
}

/** Settings on a connected sheet; a field that is not sent is left as it is (a toggle never wipes the mapping). */
export async function updateSheetAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const i = updateSheetSchema.parse(input);
    await db.withUser(session.userId, async (q) => {
      await assertSheetVisible(q, i.id);
      await updateSheetSource(q, i);
    });
    if (i.active !== false)
      await syncSheets({ db, tokenFor: productionTokenFor(), sourceId: i.id });
    revalidatePath("/settings");
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

export async function syncSheetNowAction(
  input: unknown,
): Promise<ActionResult<{ rows: number; added: number }>> {
  const session = await requireSession();
  try {
    const { id: sourceId } = z.object({ id }).parse(input);
    await db.withUser(session.userId, (q) => assertSheetVisible(q, sourceId));
    const s = await syncSheets({ db, tokenFor: productionTokenFor(), sourceId });
    if (s.failed[0]) throw new UserError(s.failed[0].error);
    revalidatePath("/settings");
    return { ok: true, data: { rows: s.rows, added: s.added } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** The intake form: type a phone, get the sheet row back in one round trip. Exact match on the last 10 digits. */
export async function lookupSheetRowAction(input: unknown): Promise<
  ActionResult<{
    id: string;
    business_name: string;
    contact_name: string;
    email: string;
    phone: string;
    phone2: string;
    email2: string;
    industry: string;
    state: string;
    wanted: string;
    notes: string;
    source_name: string;
  } | null>
> {
  const session = await requireSession();
  try {
    const { phone } = z.object({ phone: z.string().trim().min(7) }).parse(input);
    const row = await db.withUser(session.userId, async (q) => {
      const { rows } = await q.query<{
        id: string;
        business_name: string;
        contact_name: string;
        email: string;
        phone: string;
        phone2: string;
        email2: string;
        industry: string;
        state: string;
        wanted: string;
        notes: string;
        source_name: string;
      }>(
        `select r.id, r.business_name, r.contact_name, r.email, r.phone, r.phone2, r.email2, r.industry, r.state, r.wanted, r.notes,
                s.name as source_name
           from sheet_lookup($1) r join sheet_sources s on s.id = r.source_id limit 1`,
        [phone],
      );
      return rows[0] ?? null;
    });
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

/** "Submit to {bucket}" from the intake form for a row that came from a sheet. */
export async function fileSheetRowAction(
  input: unknown,
): Promise<ActionResult<{ result: string }>> {
  const session = await requireSession();
  try {
    const i = z.object({ rowId: id, bucketId: id.nullable() }).parse(input);
    const outcome = await db.withUser(session.userId, async (q) => {
      const { rows } = await q.query<PendingRow>(
        `select app.current_user_id() as owner_id, ${PENDING_ROW_COLUMNS}
           from sheet_rows r join sheet_sources s on s.id = r.source_id where r.id = $1`,
        [i.rowId],
      );
      const row = rows[0];
      if (!row) throw new UserError("That sheet row is gone");
      return fileOneRow(q, row, env().APP_URL, new Date(), i.bucketId);
    });
    revalidatePath("/", "layout");
    return { ok: true, data: { result: outcome.result } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
