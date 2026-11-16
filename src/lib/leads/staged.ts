import type { Db } from "../db";

/**
 * Bulk intake (S1-13): the sheet rows the sync staged that nobody has filed yet. Row security decides which sheets
 * the caller can see; only sheets they can also write to are listed (their own, or any for a manager), because
 * filing marks the row, and a rep cannot mark a row on a shared sheet.
 */
export interface StagedRow {
  id: string;
  source_name: string;
  target_bucket_id: string | null;
  target_bucket_name: string | null;
  business_name: string;
  contact_name: string;
  phone: string;
  email: string;
  state: string;
  industry: string;
  wanted: string;
  first_seen_at: string;
}

export async function listStagedRows(
  q: Db,
  limit = 200,
): Promise<{ rows: StagedRow[]; total: number }> {
  // one fixed query; the window count is the whole waiting list, not just the page of it that limit returns
  const { rows } = await q.query<StagedRow & { total: number }>(
    `select r.id, s.name as source_name, s.target_bucket_id, b.name as target_bucket_name, r.business_name, r.contact_name,
            r.phone, r.email, r.state, r.industry, r.wanted,
            to_char(r.first_seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as first_seen_at,
            count(*) over ()::int as total
       from sheet_rows r join sheet_sources s on s.id = r.source_id left join buckets b on b.id = s.target_bucket_id
      where s.active and r.filed_at is null and r.client_id is null
        and (s.owner_id = app.current_user_id() or app.can_see_all())
      order by r.first_seen_at desc, s.name, r.row_no
      limit $1`,
    [limit],
  );
  return {
    rows: rows.map((r) => ({
      id: r.id,
      source_name: r.source_name,
      target_bucket_id: r.target_bucket_id,
      target_bucket_name: r.target_bucket_name,
      business_name: r.business_name,
      contact_name: r.contact_name,
      phone: r.phone,
      email: r.email,
      state: r.state,
      industry: r.industry,
      wanted: r.wanted,
      first_seen_at: r.first_seen_at,
    })),
    total: rows[0]?.total ?? 0,
  };
}
