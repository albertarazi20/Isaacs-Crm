import type { MonthRow } from "@/lib/earnings/earned";
import { formatMoney } from "@/lib/money";

/** The chart's data as a table — and the funded count and dollars the chart does not draw. Newest month first. */
export function MonthTable({ months }: { months: readonly MonthRow[] }) {
  const rows = [...months].reverse();
  const total = months.reduce(
    (t, m) => ({
      fundedCount: t.fundedCount + m.fundedCount,
      fundedCents: t.fundedCents + m.fundedCents,
      commissionCents: t.commissionCents + m.commissionCents,
    }),
    { fundedCount: 0, fundedCents: 0, commissionCents: 0 },
  );
  return (
    <div className="min-w-0 overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-[13px] tabular-nums">
        <caption className="sr-only">
          Month by month: advances funded and commission received
        </caption>
        <thead className="bg-surface-2/60 text-left text-[11px] font-semibold tracking-wide text-muted uppercase">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">
              Month
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Advances funded
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Funded
            </th>
            <th scope="col" className="px-3 py-2 text-right font-semibold">
              Commission received
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((m) => (
            <tr key={m.key} className="transition hover:bg-surface-3">
              <th scope="row" className="px-3 py-1.5 text-left font-medium whitespace-nowrap">
                {m.label}
              </th>
              <td className="px-3 py-1.5 text-right">{m.fundedCount || "—"}</td>
              <td className="px-3 py-1.5 text-right">
                {m.fundedCents ? formatMoney(m.fundedCents) : "—"}
              </td>
              <td className="px-3 py-1.5 text-right font-medium">
                {m.commissionCents ? formatMoney(m.commissionCents) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-border bg-surface-2/40 font-semibold">
          <tr>
            <th scope="row" className="px-3 py-2 text-left">
              Last 12 months
            </th>
            <td className="px-3 py-2 text-right">{total.fundedCount}</td>
            <td className="px-3 py-2 text-right">{formatMoney(total.fundedCents)}</td>
            <td className="px-3 py-2 text-right">{formatMoney(total.commissionCents)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
