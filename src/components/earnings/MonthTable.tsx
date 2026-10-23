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
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <caption className="sr-only">
          Month by month: advances funded and commission received
        </caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Month
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-medium">
              Advances funded
            </th>
            <th scope="col" className="px-3 py-1.5 text-right font-medium">
              Funded
            </th>
            <th scope="col" className="py-1.5 pl-3 text-right font-medium">
              Commission received
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.key} className="border-b border-border/60">
              <th scope="row" className="py-1.5 pr-3 text-left font-medium whitespace-nowrap">
                {m.label}
              </th>
              <td className="px-3 py-1.5 text-right">{m.fundedCount || "—"}</td>
              <td className="px-3 py-1.5 text-right">
                {m.fundedCents ? formatMoney(m.fundedCents) : "—"}
              </td>
              <td className="py-1.5 pl-3 text-right font-medium">
                {m.commissionCents ? formatMoney(m.commissionCents) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <th scope="row" className="py-1.5 pr-3 text-left">
              Last 12 months
            </th>
            <td className="px-3 py-1.5 text-right">{total.fundedCount}</td>
            <td className="px-3 py-1.5 text-right">{formatMoney(total.fundedCents)}</td>
            <td className="py-1.5 pl-3 text-right">{formatMoney(total.commissionCents)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
