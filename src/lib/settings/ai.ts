import type { Db } from "../db";

/** What each AI purpose is, in words. A purpose not listed here still shows, humanised from its key. */
export const AI_PURPOSE_LABELS: Record<string, string> = {
  classify_reply: "Tagging merchant replies",
  split_lead_line: "Splitting a pasted lead line",
};

export const aiPurposeLabel = (purpose: string): string =>
  AI_PURPOSE_LABELS[purpose] ?? purpose.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

export interface AiSpendRow {
  purpose: string;
  label: string;
  runs_today: number;
  cents_today: number;
  runs_30d: number;
  cents_30d: number;
  errors_30d: number;
}

/**
 * The spend list: every purpose the AI has been used for, today and over the last 30 days, biggest spender first.
 * Reads ai_runs, which the app role may read; the cost is whatever each run logged (cents, fractions kept).
 */
export async function aiSpendByPurpose(q: Db): Promise<AiSpendRow[]> {
  const { rows } = await q.query<Omit<AiSpendRow, "label">>(
    `select purpose,
            count(*) filter (where created_at >= date_trunc('day', now()))::int as runs_today,
            coalesce(sum(cost_cents) filter (where created_at >= date_trunc('day', now())), 0)::float8 as cents_today,
            count(*)::int as runs_30d,
            coalesce(sum(cost_cents), 0)::float8 as cents_30d,
            count(*) filter (where error is not null)::int as errors_30d
       from ai_runs where created_at > now() - interval '30 days'
      group by purpose order by cents_30d desc, purpose`,
  );
  return rows.map((r) => ({ ...r, label: aiPurposeLabel(r.purpose) }));
}
