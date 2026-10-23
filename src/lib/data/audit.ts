import { formatMoney } from "../money";

/** The details Edit details can change, with the words the timeline uses for them. */
export const EDIT_LABELS = {
  business_name: "business name",
  dba: "DBA",
  contact_name: "merchant name",
  phone: "phone",
  email: "email",
  industry: "industry",
  state: "state",
  source: "source",
  monthly_revenue_cents: "monthly revenue",
  time_in_business_months: "time in business (months)",
  application_received_on: "application date",
} as const;

export type EditedColumn = keyof typeof EDIT_LABELS;

const show = (column: EditedColumn, v: unknown): string => {
  if (v === null || v === undefined || v === "") return "blank";
  if (column === "monthly_revenue_cents") return formatMoney(Number(v));
  // a date column comes back as text or a Date depending on the driver
  const text = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

/**
 * "Edited details: phone 3055550100 → 7865550123; industry blank → Restaurant" — what changed on a merchant, for the
 * timeline. Null when nothing did, so saving without a change leaves no line.
 */
export function describeEdit(
  before: Partial<Record<EditedColumn, unknown>>,
  after: Partial<Record<EditedColumn, unknown>>,
): string | null {
  const parts: string[] = [];
  for (const column of Object.keys(EDIT_LABELS) as EditedColumn[]) {
    const was = show(column, before[column]);
    const now = show(column, after[column]);
    if (was !== now) parts.push(`${EDIT_LABELS[column]} ${was} → ${now}`);
  }
  return parts.length > 0 ? `Edited details: ${parts.join("; ")}` : null;
}
