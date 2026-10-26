import { db, type DbAccess } from "../db";
import { hashToken, MAX_PER_MINUTE } from "../leads/token";

export type TokenCheck =
  | { ok: true; tokenId: string; userId: string; email: string }
  | { ok: false; reason: "invalid" | "rate_limited" };

/**
 * Checks a presented lead token and counts this attempt, in one statement. Runs on the owner connection:
 * the caller has no session yet. The window is one minute; every attempt on a live token counts, including
 * the ones that get refused.
 */
export async function checkLeadToken(token: string, access: DbAccess = db): Promise<TokenCheck> {
  return access.withSystem(async (q) => {
    const { rows } = await q.query<{
      id: string;
      user_id: string;
      email: string;
      window_count: number;
    }>(
      `update lead_tokens t set
              window_count = case when t.window_start < now() - interval '1 minute' then 1 else t.window_count + 1 end,
              window_start = case when t.window_start < now() - interval '1 minute' then now() else t.window_start end,
              last_used_at = now()
         from app_users u
        where t.token_hash = $1 and t.revoked_at is null and u.id = t.user_id
    returning t.id, t.user_id, u.email, t.window_count`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: "invalid" };
    if (row.window_count > MAX_PER_MINUTE) return { ok: false, reason: "rate_limited" };
    return { ok: true, tokenId: row.id, userId: row.user_id, email: row.email };
  });
}
