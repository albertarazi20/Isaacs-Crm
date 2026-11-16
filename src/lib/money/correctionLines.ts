import { formatMoney } from "../money";

/** What a correction can touch, in the order a person reads a funding, and how each value reads. */
const FIELDS: { key: string; label: string; kind: "money" | "plain" }[] = [
  { key: "amount_cents", label: "Amount", kind: "money" },
  { key: "sell_rate", label: "Factor", kind: "plain" },
  { key: "buy_rate", label: "Buy rate", kind: "plain" },
  { key: "points", label: "Points", kind: "plain" },
  { key: "psf_cents", label: "PSF", kind: "money" },
  { key: "commission_cents", label: "Commission", kind: "money" },
  { key: "rep_cut_cents", label: "Rep cut", kind: "money" },
  { key: "funder_name", label: "Lender", kind: "plain" },
  { key: "payment_cents", label: "Payment", kind: "money" },
  { key: "frequency", label: "Frequency", kind: "plain" },
  { key: "term_days", label: "Term", kind: "plain" },
];

function show(v: unknown, kind: "money" | "plain"): string {
  if (v === null || v === undefined || v === "") return "—";
  return kind === "money" ? formatMoney(Number(v)) : String(v);
}

/** ["Buy rate 1.28 → 1.29", "Commission $3,500 → $3,000"]: only what changed between the two snapshots. */
export function changeLines(c: {
  old_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
}): string[] {
  return FIELDS.filter(
    (f) => show(c.old_values[f.key], f.kind) !== show(c.new_values[f.key], f.kind),
  ).map(
    (f) => `${f.label} ${show(c.old_values[f.key], f.kind)} → ${show(c.new_values[f.key], f.kind)}`,
  );
}

/** "+$350" / "−$500": a ledger delta with its sign. */
export function signedMoney(cents: number | null): string {
  return cents === null ? "—" : `${cents < 0 ? "−" : "+"}${formatMoney(Math.abs(cents))}`;
}
