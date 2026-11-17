import { cn } from "@/components/ui";
import type { AiSpendRow } from "@/lib/settings/ai";
import { centsText } from "@/lib/settings/format";
import { SettingsCard, SHEET } from "./primitives";

/**
 * What each kind of AI work cost: tagging replies and splitting the pasted lead line. A server component; the page
 * passes the rows.
 */
export function AiSpendCard({ rows }: { rows: AiSpendRow[] }) {
  return (
    <SettingsCard
      title="Spend by purpose"
      description="What each kind of AI work cost, today and over the last 30 days. The daily cap above counts all of it."
      flush
    >
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-[13px] text-muted sm:px-5">
          Nothing has run in the last 30 days.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className={cn(SHEET.table, "min-w-[620px]")}>
            <thead className={SHEET.thead}>
              <tr>
                <th className={SHEET.th}>Purpose</th>
                <th className={SHEET.thNum}>Runs today</th>
                <th className={SHEET.thNum}>Spent today</th>
                <th className={SHEET.thNum}>Runs, 30 days</th>
                <th className={SHEET.thNum}>Spent, 30 days</th>
                <th className={SHEET.thNum}>Errors</th>
              </tr>
            </thead>
            <tbody className={SHEET.tbody}>
              {rows.map((r) => (
                <tr key={r.purpose} className={SHEET.tr} data-purpose={r.purpose}>
                  <td className={cn(SHEET.td, "font-medium")}>{r.label}</td>
                  <td className={SHEET.tdNum}>{r.runs_today}</td>
                  <td className={SHEET.tdNum}>{centsText(r.cents_today)}</td>
                  <td className={SHEET.tdNum}>{r.runs_30d}</td>
                  <td className={SHEET.tdNum}>{centsText(r.cents_30d)}</td>
                  <td className={cn(SHEET.tdNum, r.errors_30d > 0 && "font-semibold text-bad")}>
                    {r.errors_30d}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsCard>
  );
}
