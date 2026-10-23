import type { Db } from "../db";

export interface LeadTokenRow {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

/** The user's live connections, newest first. The hash is never readable here — the database refuses it. */
export async function listLeadTokens(q: Db): Promise<LeadTokenRow[]> {
  const { rows } = await q.query<LeadTokenRow>(
    `select id, label, created_at, last_used_at
       from lead_tokens
      where revoked_at is null
      order by created_at desc`,
  );
  return rows;
}
