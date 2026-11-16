import type { Db } from "../db";
import { aiBlockedWords } from "./aiWords";

/**
 * Whether the AI controls on the deal page can run: the server has a key, the kill switch is on, and today's spend
 * is under the cap. Returns the plain-words reason when they cannot, so the control can say why it is disabled.
 */
export async function aiBlockedReason(q: Db, keyPresent: boolean): Promise<string | null> {
  const s = (
    await q.query<{ ai_enabled: boolean; ai_daily_cap_cents: number; spent: string }>(
      "select ai_enabled, ai_daily_cap_cents, app.ai_spent_today_cents()::text as spent from shop_settings",
    )
  ).rows[0];
  return aiBlockedWords({
    keyPresent,
    enabled: s?.ai_enabled ?? false,
    spentCents: Number(s?.spent ?? 0),
    capCents: s?.ai_daily_cap_cents ?? 0,
  });
}
