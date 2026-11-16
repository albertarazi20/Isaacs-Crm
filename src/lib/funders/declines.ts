import {
  DECLINE_CATEGORIES,
  DECLINE_CATEGORY_LABELS,
  type DeclineCategory,
  type DeclineReasonRow,
} from "./types";

export interface DeclineGroup {
  category: DeclineCategory;
  label: string;
  reasons: DeclineReasonRow[];
}

/** The `decline_reasons` rows grouped by category, in the table's own order (sort, then key). */
export function groupDeclineReasons(rows: readonly DeclineReasonRow[]): DeclineGroup[] {
  const sorted = [...rows].sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
  return DECLINE_CATEGORIES.map((category) => ({
    category,
    label: DECLINE_CATEGORY_LABELS[category],
    reasons: sorted.filter((r) => r.category === category),
  })).filter((g) => g.reasons.length > 0);
}

/** "Winback can try this merchant again after 60 days" / "Not something time fixes" — the reason's clock. */
export function curableText(r: DeclineReasonRow | undefined): string {
  if (!r) return "";
  if (r.curable_after_days === null)
    return "Not something time fixes — Winback leaves this one alone";
  return `Winback can try this merchant again after ${r.curable_after_days} days`;
}
