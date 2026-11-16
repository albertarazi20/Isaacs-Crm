import { Badge, cn } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import type { ClosedMonth } from "@/lib/settings/statements";
import { ICON, Icon, SettingsCard, SHEET } from "./primitives";

const money = (c: number) => formatMoney(c, { cents: true });

/**
 * The month-end close (0521) as a list: one block per closed month with the shop's totals, one row per person's
 * statement, and a plain printable page for each. A server component: the page passes the closed months.
 */
export function StatementsCard({ months }: { months: ClosedMonth[] }) {
  return (
    <SettingsCard
      title="Month-end statements"
      description="When a month closes its commission lines are locked and each person gets a statement. A correction after the close is a new line in the current month. Open a statement to print it or save it as a PDF."
      aside={
        <Badge tone="neutral" className="tabular-nums">
          {months.length}
        </Badge>
      }
      flush
      className="relative min-w-0 overflow-x-auto"
    >
      {months.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted">
          No month has closed yet. The first close runs on the 1st of the month after a funding.
        </p>
      ) : (
        <table className={cn(SHEET.table, "border-t border-border")}>
          <thead className={SHEET.thead}>
            <tr>
              <th className={SHEET.th}>Month / person</th>
              <th className={SHEET.thNum}>Lines</th>
              <th className={SHEET.thNum}>Gross</th>
              <th className={SHEET.thNum}>Rep</th>
              <th className={SHEET.thNum}>House</th>
              <th className={SHEET.th}>
                <span className="sr-only">Printable view</span>
              </th>
            </tr>
          </thead>
          {months.map((m) => (
            <tbody key={m.period} className={SHEET.tbody} data-month={m.period}>
              <tr className="bg-surface-2/60">
                <td className={cn(SHEET.td, "font-semibold")}>
                  {m.label}
                  <span className="ml-2 text-xs font-normal text-muted">
                    closed {m.closed_at.slice(0, 10)}
                  </span>
                </td>
                <td className={cn(SHEET.tdNum, "font-semibold")}>{m.line_count}</td>
                <td className={cn(SHEET.tdNum, "font-semibold")}>{money(m.gross_cents)}</td>
                <td className={cn(SHEET.tdNum, "font-semibold")}>{money(m.rep_cents)}</td>
                <td className={cn(SHEET.tdNum, "font-semibold")}>{money(m.house_cents)}</td>
                <td className={SHEET.td} />
              </tr>
              {m.statements.map((s) => (
                <tr key={s.id} className={SHEET.tr} data-statement={s.id}>
                  <td className={cn(SHEET.td, "pl-8!")}>
                    {s.name}
                    {s.emailed_at ? <span className="ml-2 text-xs text-muted">emailed</span> : null}
                  </td>
                  <td className={SHEET.tdNum}>{s.line_count}</td>
                  <td className={SHEET.tdNum}>{money(s.gross_cents)}</td>
                  <td className={SHEET.tdNum}>{money(s.rep_cents)}</td>
                  <td className={SHEET.tdNum}>{money(s.house_cents)}</td>
                  <td className={cn(SHEET.td, "text-right whitespace-nowrap")}>
                    <a
                      href={`/settings/plan/statements/${s.id}`}
                      target="_blank"
                      rel="noopener"
                      aria-label={`Printable statement for ${s.name}, ${m.label}`}
                      className="inline-flex min-h-8 items-center gap-1 text-sm font-medium text-accent hover:underline"
                    >
                      Print
                      <Icon d={ICON.external} className="size-3.5" />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      )}
    </SettingsCard>
  );
}
