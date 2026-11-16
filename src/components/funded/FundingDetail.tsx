import { Badge, Button } from "@/components/ui";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import type { FundedRow } from "@/lib/money/fund";
import type { CorrectionLine, FundingExtra } from "@/lib/money/fundedExtras";

/** What a correction can touch, in the order a person reads a funding, and how each reads. */
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

/** "Amount $80,000 → $75,000; Commission $5,600 → $5,250": only what changed. */
export function changeLines(c: Pick<CorrectionLine, "old_values" | "new_values">): string[] {
  return FIELDS.filter(
    (f) => show(c.old_values[f.key], f.kind) !== show(c.new_values[f.key], f.kind),
  ).map(
    (f) => `${f.label} ${show(c.old_values[f.key], f.kind)} → ${show(c.new_values[f.key], f.kind)}`,
  );
}

const signed = (cents: number | null): string =>
  cents === null ? "—" : `${cents < 0 ? "−" : "+"}${formatMoney(Math.abs(cents))}`;

/** The row's detail: where the lender's payout stands, and every correction as a dated line. */
export function FundingDetail({
  row,
  extra,
  today,
  manager,
  onCorrect,
}: {
  row: FundedRow;
  extra: FundingExtra | undefined;
  today: string;
  manager: boolean;
  onCorrect: () => void;
}) {
  const lines = extra?.corrections ?? [];
  const late = extra?.late_days !== null && extra?.late_days !== undefined && extra.late_days > 0;
  return (
    <div className="sticky left-4 w-[calc(100vw-4rem)] max-w-3xl space-y-3 text-sm sm:w-auto">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
        <div>
          <dt className="text-xs text-muted">Lender pays commission by</dt>
          <dd className="font-medium tabular-nums">
            {extra?.expected_on ? formatDate(extra.expected_on, today) : "Not tracked"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Still owed by the lender</dt>
          <dd className="font-medium tabular-nums">
            {formatMoney(extra?.owed_cents ?? 0)}{" "}
            {late ? <Badge tone="bad">{extra?.late_days} days late</Badge> : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Received so far</dt>
          <dd className="font-medium tabular-nums">
            {formatMoney(row.commission_received_cents ?? 0)}
          </dd>
        </div>
      </dl>
      <div>
        <h3 className="text-[13px] font-semibold">Corrections</h3>
        {lines.length === 0 ? (
          <p className="mt-1 text-xs text-muted">
            No corrections. A confirmed funding keeps its terms; a manager can correct it, and the
            difference posts as a dated line.
          </p>
        ) : (
          <ul className="mt-1 divide-y divide-border rounded-lg border border-border bg-surface">
            {lines.map((c) => (
              <li
                key={c.id}
                className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-xs text-muted">
                    {formatDate((c.line_on ?? c.created_at).slice(0, 10), today)}
                    {c.corrected_by_name ? ` · ${c.corrected_by_name}` : ""}
                  </p>
                  <p className="font-medium">{c.reason}</p>
                  <p className="text-xs text-text-2">{changeLines(c).join("; ") || "No change"}</p>
                </div>
                <p className="text-right text-xs text-muted tabular-nums">
                  Commission{" "}
                  <span className="font-semibold text-text">{signed(c.gross_cents)}</span>
                  <br />
                  Rep cut <span className="font-semibold text-text">{signed(c.rep_cents)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
      {manager && row.confirmed_at ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={onCorrect}>
            Correct this funding
          </Button>
        </div>
      ) : null}
    </div>
  );
}
