import type { Db } from "../db";

/**
 * Whether "paste a lead line" can run right now, and the words when it cannot. The action refuses with the same
 * words, so a disabled box and a refused call never disagree. Pure; `assistantState` reads the shop's AI settings.
 */

export const ASSISTANT_REFUSALS = {
  notSetUp: "The assistant is not set up on this server",
  off: "The assistant is switched off in Settings",
  budget: "The assistant has used today's budget. Type the lead in by hand",
} as const;

export function assistantRefusal(s: {
  keySet: boolean;
  enabled: boolean;
  capCents: number;
  spentCents: number;
}): string | null {
  if (!s.keySet) return ASSISTANT_REFUSALS.notSetUp;
  if (!s.enabled) return ASSISTANT_REFUSALS.off;
  if (s.spentCents >= s.capCents) return ASSISTANT_REFUSALS.budget;
  return null;
}

export interface AssistantState {
  ready: boolean;
  /** Why not, in words; empty when ready. */
  reason: string;
}

export async function assistantState(q: Db, keySet: boolean): Promise<AssistantState> {
  if (!keySet) return { ready: false, reason: ASSISTANT_REFUSALS.notSetUp };
  const { rows } = await q.query<{ ai_enabled: boolean; cap: number; spent: string }>(
    "select ai_enabled, ai_daily_cap_cents as cap, app.ai_spent_today_cents()::text as spent from shop_settings",
  );
  const s = rows[0];
  const reason = assistantRefusal({
    keySet,
    enabled: s?.ai_enabled ?? false,
    capCents: s?.cap ?? 0,
    spentCents: Number(s?.spent ?? 0),
  });
  return { ready: reason === null, reason: reason ?? "" };
}
