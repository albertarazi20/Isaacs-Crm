import { z } from "zod";
import type { Db, DbAccess } from "../db";
import { UserError } from "../data/mutations";
import { id, line } from "../data/schemas";
import { listTabs } from "./api";
import { gidFrom, LEAD_FIELDS, spreadsheetIdFrom } from "./mapping";
import { syncSheets, type TokenFor } from "./sync";

/**
 * Connecting a sheet and changing its settings, apart from the session: the Settings panel's two actions call
 * these, and the tests call them with a fake Google.
 */

/** What the panel sends. The name is optional: blank means "call it what the spreadsheet is called". */
export const connectSheetSchema = z.object({
  name: line(80).default(""),
  url: z.string().trim().min(1, "Paste the sheet link"),
  tab: line(100).default(""),
  targetBucketId: id.nullable().default(null),
  autoFile: z.boolean().default(false),
  shared: z.boolean().default(false),
});
export type ConnectSheetInput = z.output<typeof connectSheetSchema>;

/** The sheet's name in Settings: what was typed, else the spreadsheet's title, else the tab, else "Sheet". */
export function sheetNameFor(typed: string, spreadsheetTitle: string, tab: string): string {
  return (typed.trim() || spreadsheetTitle.trim() || tab.trim() || "Sheet").slice(0, 80);
}

/** The link is checked against Google right away, so a bad share shows up now, not at 3am. */
export async function connectSheet(args: {
  db: DbAccess;
  userId: string;
  input: ConnectSheetInput;
  tokenFor: TokenFor;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; tabs: string[] }> {
  const { input: i } = args;
  const spreadsheetId = spreadsheetIdFrom(i.url);
  if (!spreadsheetId) throw new UserError("That doesn't look like a Google Sheets link");
  const token = await args.tokenFor(args.userId);
  const meta = await listTabs(token, spreadsheetId, args.fetchImpl);
  const gid = gidFrom(i.url);
  const tab = i.tab || meta.tabs.find((t) => t.gid === gid)?.title || meta.tabs[0]?.title || "";
  const created = await args.db.withUser(args.userId, async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `insert into sheet_sources (owner_id, name, spreadsheet_id, sheet_title, target_bucket_id, auto_file, reader_user_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        i.shared ? null : args.userId,
        sheetNameFor(i.name, meta.title, tab),
        spreadsheetId,
        tab,
        i.targetBucketId,
        i.autoFile,
        args.userId,
      ],
    );
    return rows[0]?.id;
  });
  if (!created) throw new Error("sheet_sources insert returned no row");
  await syncSheets({
    db: args.db,
    tokenFor: args.tokenFor,
    fetchImpl: args.fetchImpl,
    sourceId: created,
  });
  return { id: created, tabs: meta.tabs.map((t) => t.title) };
}

/**
 * Settings on a connected sheet. Every field is optional and an absent one is left alone — "Auto-file" and
 * "Turn off" send only their own flag, so the column mapping is never wiped by a toggle.
 */
export const updateSheetSchema = z.object({
  id,
  mapping: z.partialRecord(z.enum(LEAD_FIELDS), z.number().int().min(0).max(200)).optional(),
  targetBucketId: id.nullable().optional(),
  autoFile: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type UpdateSheetInput = z.output<typeof updateSheetSchema>;

export async function updateSheetSource(q: Db, i: UpdateSheetInput): Promise<void> {
  await q.query(
    `update sheet_sources set mapping = coalesce($2::jsonb, mapping),
            target_bucket_id = case when $6::boolean then $3::uuid else target_bucket_id end,
            auto_file = coalesce($4, auto_file),
            active = coalesce($5, active)
      where id = $1`,
    [
      i.id,
      i.mapping === undefined ? null : JSON.stringify(i.mapping),
      i.targetBucketId ?? null,
      i.autoFile ?? null,
      i.active ?? null,
      // null is "no bucket"; an absent field leaves the bucket alone
      i.targetBucketId !== undefined,
    ],
  );
}
