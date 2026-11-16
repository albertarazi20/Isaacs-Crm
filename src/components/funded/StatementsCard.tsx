import Link from "next/link";
import { SHEET } from "@/components/settings/primitives";
import { Badge, Card, SectionTitle, cn } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { periodLabel } from "@/lib/money/close";
import type { StatementMonth } from "@/lib/money/fundedExtras";
import { CloseMonthButton } from "./CloseMonthButton";

/**
 * Commission statements per month: a closed month opens as a readable page (and prints). A manager also sees the
 * past months whose lines are still open, each with its Close month button.
 */
export function StatementsCard({
  months,
  toClose,
  manager,
}: {
  months: StatementMonth[];
  /** First-of-month dates, newest first; only given to a manager. */
  toClose: string[];
  manager: boolean;
}) {
  const waiting = toClose.filter((p) => !months.some((m) => m.period === p));
  if (months.length === 0 && waiting.length === 0) return null;
  return (
    <Card className="min-w-0 overflow-x-auto p-0">
      <div className="px-4 pt-3.5 pb-3">
        <SectionTitle>Commission statements</SectionTitle>
        <p className="mt-1 max-w-3xl text-xs text-muted">
          Closing a month locks its commission lines and builds each person&apos;s statement. A
          later correction is a new dated line in the month after.
        </p>
      </div>
      <table className={SHEET.table}>
        <thead className={SHEET.thead}>
          <tr>
            <th className={SHEET.th}>Month</th>
            <th className={cn(SHEET.thNum, "hidden sm:table-cell")}>Statements</th>
            <th className={cn(SHEET.thNum, "hidden sm:table-cell")}>Gross</th>
            <th className={SHEET.thNum}>{manager ? "Rep cuts" : "My cut"}</th>
            <th className={SHEET.th}>Status</th>
            <th className={SHEET.th}></th>
          </tr>
        </thead>
        <tbody className={SHEET.tbody}>
          {manager
            ? waiting.map((p) => (
                <tr key={p} className={SHEET.tr}>
                  <td className={cn(SHEET.td, "font-medium whitespace-nowrap")}>
                    {periodLabel(p)}
                  </td>
                  <td className={cn(SHEET.tdNum, "hidden sm:table-cell")}>—</td>
                  <td className={cn(SHEET.tdNum, "hidden sm:table-cell")}>—</td>
                  <td className={SHEET.tdNum}>—</td>
                  <td className={SHEET.td}>
                    <Badge tone="warn">Open</Badge>
                  </td>
                  <td className={cn(SHEET.td, "text-right")}>
                    <CloseMonthButton period={p.slice(0, 7)} label={periodLabel(p)} />
                  </td>
                </tr>
              ))
            : null}
          {months.map((m) => (
            <tr key={m.period} className={SHEET.tr}>
              <td className={cn(SHEET.td, "font-medium whitespace-nowrap")}>
                <Link
                  href={`/funded/statements/${m.period.slice(0, 7)}`}
                  className="hover:underline"
                >
                  {periodLabel(m.period)}
                </Link>
              </td>
              <td className={cn(SHEET.tdNum, "hidden sm:table-cell")}>{m.statements}</td>
              <td className={cn(SHEET.tdNum, "hidden sm:table-cell")}>
                {formatMoney(m.gross_cents)}
              </td>
              <td className={SHEET.tdNum}>{formatMoney(m.rep_cents)}</td>
              <td className={SHEET.td}>
                <Badge tone="good">Closed</Badge>
              </td>
              <td className={cn(SHEET.td, "text-right")}>
                <Link
                  href={`/funded/statements/${m.period.slice(0, 7)}`}
                  className="text-xs font-medium text-accent hover:underline"
                  aria-label={`Open the ${periodLabel(m.period)} statement`}
                >
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
