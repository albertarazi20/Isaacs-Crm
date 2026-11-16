import type { Db } from "../db";
import { labelOf, type DocKind } from "../docs/label";

/**
 * What the checklist calls a missing item. A stip of kind 'other' carries the lender's own words in `stips.label`
 * (0511), so "Other document" never shows when the lender said what it wants. Pure, so the wording is tested.
 */
export function stipDisplayLabel(kind: DocKind, period: string | null, label: string): string {
  const own = label.trim();
  if (kind === "other" && own !== "") return own;
  return labelOf(kind, period);
}

/** The merchant's required stips that have not come in, in the words the deal page shows. */
export async function missingStipLabels(q: Db, clientId: string): Promise<string[]> {
  const { rows } = await q.query<{ kind: DocKind; period: string | null; label: string }>(
    `select kind, period::text as period, label from stips
      where client_id = $1 and required and received_at is null order by kind, period`,
    [clientId],
  );
  return rows.map((r) => stipDisplayLabel(r.kind, r.period, r.label));
}
