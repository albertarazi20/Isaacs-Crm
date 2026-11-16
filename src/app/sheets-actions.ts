"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CAN, requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { UserError } from "@/lib/data/mutations";
import { id, line } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { listTabs } from "@/lib/sheets/api";
import { fileOneRow } from "@/lib/sheets/file";
import { gidFrom, LEAD_FIELDS, spreadsheetIdFrom } from "@/lib/sheets/mapping";
import { productionTokenFor, syncSheets } from "@/lib/sheets/sync";
import { env } from "@/lib/env";

const connectSchema = z.object({
  name: line(80).min(1, "Name this sheet"),
  url: z.string().trim().min(1, "Paste the sheet link"),
  tab: line(100).default(""),
  targetBucketId: id.nullable().default(null),
  autoFile: z.boolean().default(false),
  shared: z.boolean().default(false),
});

/** Connect a sheet: the link is checked against Google right away, so a bad share shows up now, not at 3am. */
export async function connectSheetAction(
  input: unknown,
): Promise<ActionResult<{ id: string; tabs: string[] }>> {
  const session = await requireSession();
  try {
    const i = connectSchema.parse(input);
    const spreadsheetId = spreadsheetIdFrom(i.url);
    if (!spreadsheetId) throw new UserError("That doesn't look like a Google Sheets link");
    if (i.shared && !CAN.manageTeam(session.role))
      throw new UserError("Only a manager can share a sheet with everyone");
    const token = await productionTokenFor()(session.userId);
    const meta = await listTabs(token, spreadsheetId);
    const gid = gidFrom(i.url);
    const tab = i.tab || meta.tabs.find((t) => t.gid === gid)?.title || meta.tabs[0]?.title || "";
    const created = await db.withUser(session.userId, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `insert into sheet_sources (owner_id, name, spreadsheet_id, sheet_title, target_bucket_id, auto_file, reader_user_id)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          i.shared ? null : session.userId,
          i.name,
          spreadsheetId,
          tab,
          i.targetBucketId,
          i.autoFile,
          session.userId,
        ],
      );
      return rows[0]?.id;
    });
    if (!created) throw new Error("sheet_sources insert returned no row");
    await syncSheets({ db, tokenFor: productionTokenFor(), sourceId: created });
    revalidatePath("/settings");
    return { ok: true, data: { id: created, tabs: meta.tabs.map((t) => t.title) } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}

const mappingSchema = z.object({
  id,
  mapping: z.record(z.enum(LEAD_FIELDS), z.number().int().min(0).max(200)),
  targetBucketId: id.nullable().optional(),
  autoFile: z.boolean().optional(),
  active: z.boolean().optional(),
});

export async function updateSheetAction(input: unknown): Promise<ActionResult<null>> {
  const session = await requireSession();
  try {
    const i = mappingSchema.parse(input);
    await db.withUser(session.userId, (q) =>
      q.query(
        `update sheet_sources set mapping = $2,
                target_bucket_id = coalesce($3, target_bucket_id),
                auto_file = coalesce($4, auto_file),
                active = coalesce($5, active)
          where id = $1`,
        [
          i.id,
          JSON.stringify(i.mapping),
          i.targetBucketId ?? null,
          i.autoFile ?? null,
          i.active ?? null,
        ],
      ),
    );
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
  await requireSession();
  try {
    const { id: sourceId } = z.object({ id }).parse(input);
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
    const result = await db.withUser(session.userId, async (q) => {
      const { rows } = await q.query(
        `select r.id, r.source_id, $2::uuid as owner_id, s.target_bucket_id, s.name as source_name, r.business_name, r.contact_name,
                r.email, r.phone, r.phone2, r.industry, r.state, r.monthly_revenue_cents, r.wanted, r.notes
           from sheet_rows r join sheet_sources s on s.id = r.source_id where r.id = $1`,
        [i.rowId, session.userId],
      );
      const row = rows[0];
      if (!row) throw new UserError("That sheet row is gone");
      return fileOneRow(q, row, env().APP_URL, new Date(), i.bucketId);
    });
    revalidatePath("/", "layout");
    return { ok: true, data: { result } };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
