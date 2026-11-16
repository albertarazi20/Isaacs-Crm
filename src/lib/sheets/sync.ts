import { createHash } from "node:crypto";
import type { Db, DbAccess } from "../db";
import { googleAccessTokenFor } from "../system/gmail";
import { listTabs, readTab } from "./api";
import { guessMapping, isLeadRow, parseRow, type Mapping } from "./mapping";

/**
 * Pull every connected sheet into sheet_rows (the staging copy). Runs on the owner connection every few minutes;
 * rows are matched to earlier copies by row number, their hash tells whether anything changed, and a row seen for
 * the first time is "new" for the daily loop. Reading never touches the sheet itself.
 */

export interface SyncSummary {
  sources: number;
  rows: number;
  added: number;
  changed: number;
  failed: { sourceId: string; error: string }[];
}

interface SourceRow {
  id: string;
  spreadsheet_id: string;
  sheet_title: string;
  header_row: number;
  mapping: Mapping;
  reader_user_id: string | null;
  owner_id: string | null;
}

type TokenFor = (userId: string) => Promise<string>;

/** An access token for a user's connected Google account. The refresh token stays inside lib/system. */
export function productionTokenFor(): TokenFor {
  return (userId) => googleAccessTokenFor(userId, "sheets");
}

const hashRow = (cells: readonly string[]) =>
  createHash("sha1").update(JSON.stringify(cells)).digest("hex");

export async function syncSheets(args: {
  db: DbAccess;
  tokenFor: TokenFor;
  fetchImpl?: typeof fetch;
  /** Sync only this source (a manager pressed "Sync now"). */
  sourceId?: string;
}): Promise<SyncSummary> {
  const summary: SyncSummary = { sources: 0, rows: 0, added: 0, changed: 0, failed: [] };
  const sources = await args.db.withSystem(
    async (q) =>
      (
        await q.query<SourceRow>(
          `select id, spreadsheet_id, sheet_title, header_row, mapping, reader_user_id, owner_id
             from sheet_sources where active and ($1::uuid is null or id = $1) order by created_at`,
          [args.sourceId ?? null],
        )
      ).rows,
  );
  summary.sources = sources.length;
  for (const src of sources) {
    try {
      const reader = src.reader_user_id ?? src.owner_id;
      if (!reader) throw new Error("No Google account is set to read this sheet");
      const token = await args.tokenFor(reader);
      let title = src.sheet_title;
      if (!title) {
        const tabs = await listTabs(token, src.spreadsheet_id, args.fetchImpl);
        title = tabs.tabs[0]?.title ?? "";
      }
      const grid = await readTab(token, src.spreadsheet_id, title, args.fetchImpl);
      const headerIdx = src.header_row - 1;
      const header = grid[headerIdx] ?? [];
      const mapping: Mapping = Object.keys(src.mapping).length ? src.mapping : guessMapping(header);
      const n = await args.db.withSystem(async (q) => {
        if (!Object.keys(src.mapping).length)
          await q.query("update sheet_sources set mapping = $2 where id = $1", [
            src.id,
            JSON.stringify(mapping),
          ]);
        if (!src.sheet_title && title)
          await q.query("update sheet_sources set sheet_title = $2 where id = $1", [src.id, title]);
        let added = 0;
        let changed = 0;
        let rows = 0;
        for (let i = headerIdx + 1; i < grid.length; i += 1) {
          const cells = grid[i] ?? [];
          if (cells.every((c) => c.trim() === "")) continue;
          const parsed = parseRow(cells, mapping);
          if (!isLeadRow(parsed)) continue;
          rows += 1;
          const r = await upsertRow(q, src.id, i + 1, cells, parsed);
          if (r === "added") added += 1;
          else if (r === "changed") changed += 1;
        }
        await q.query(
          "update sheet_sources set last_synced_at = now(), last_error = null, row_count = $2 where id = $1",
          [src.id, rows],
        );
        return { rows, added, changed };
      });
      summary.rows += n.rows;
      summary.added += n.added;
      summary.changed += n.changed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      summary.failed.push({ sourceId: src.id, error: msg });
      await args.db.withSystem((q) =>
        q.query("update sheet_sources set last_error = $2 where id = $1", [src.id, msg]),
      );
    }
  }
  return summary;
}

async function upsertRow(
  q: Db,
  sourceId: string,
  rowNo: number,
  cells: readonly string[],
  p: ReturnType<typeof parseRow>,
): Promise<"added" | "changed" | "same"> {
  const hash = hashRow(cells);
  const { rows } = await q.query<{ row_hash: string }>(
    "select row_hash from sheet_rows where source_id = $1 and row_no = $2",
    [sourceId, rowNo],
  );
  const existing = rows[0];
  if (existing && existing.row_hash === hash) {
    await q.query(
      "update sheet_rows set last_seen_at = now() where source_id = $1 and row_no = $2",
      [sourceId, rowNo],
    );
    return "same";
  }
  await q.query(
    `insert into sheet_rows (source_id, row_no, phone_key, business_name, contact_name, email, phone, phone2, email2, industry, state,
                             monthly_revenue_cents, time_in_business_months, wanted, notes, raw, row_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     on conflict (source_id, row_no) do update set
       phone_key = excluded.phone_key, business_name = excluded.business_name, contact_name = excluded.contact_name,
       email = excluded.email, phone = excluded.phone, phone2 = excluded.phone2, email2 = excluded.email2,
       industry = excluded.industry, state = excluded.state, monthly_revenue_cents = excluded.monthly_revenue_cents,
       time_in_business_months = excluded.time_in_business_months, wanted = excluded.wanted, notes = excluded.notes,
       raw = excluded.raw, row_hash = excluded.row_hash, last_seen_at = now()`,
    [
      sourceId,
      rowNo,
      p.phone_key,
      p.business_name,
      p.contact_name,
      p.email,
      p.phone,
      p.phone2,
      p.email2,
      p.industry,
      p.state,
      p.monthly_revenue_cents,
      p.time_in_business_months,
      p.wanted,
      p.notes,
      JSON.stringify(cells),
      hash,
    ],
  );
  return existing ? "changed" : "added";
}
