import { SHEET } from "@/components/settings/primitives";
import { Card, SectionTitle, cn } from "@/components/ui";
import { formatMoneyCompact } from "@/lib/money";
import type { RecoveredRow } from "@/lib/money/winback";

/** "winback:approved_unfunded:2" → "Step 2 email"; no email before the money came back → a plain sentence. */
export function templateLabel(source: string | null): string {
  const step = source ? /^winback:[^:]+:(\d+)$/.exec(source)?.[1] : undefined;
  if (step) return `Step ${step} email`;
  return source ? source : "Funded before any email";
}

/** What funded after a member was worked: per pool, and inside each pool per email (the last one that went). */
export function RecoveredCard({ rows, months }: { rows: RecoveredRow[]; months: number }) {
  const pools = new Map<string, { name: string; rows: RecoveredRow[] }>();
  for (const r of rows) {
    const p = pools.get(r.pool) ?? { name: r.pool_name, rows: [] };
    p.rows.push(r);
    pools.set(r.pool, p);
  }
  const total = rows.reduce((n, r) => n + r.funded_cents, 0);
  return (
    <Card className="min-w-0 overflow-x-auto p-0">
      <div className="px-4 pt-3.5 pb-3">
        <SectionTitle
          aside={
            <span className="text-sm font-semibold tabular-nums" aria-label="Recovered in total">
              {formatMoneyCompact(total)}
            </span>
          }
        >
          Recovered money
        </SectionTitle>
        <p className="mt-1 max-w-3xl text-xs text-muted">
          Merchants who funded after being worked in a pool, last {months} months. Each line is the
          last email that went before the money came back.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="border-t border-border px-4 py-4 text-sm text-muted">
          Nobody has funded after being worked yet.
        </p>
      ) : (
        <table className={SHEET.table}>
          <thead className={SHEET.thead}>
            <tr>
              <th className={SHEET.th}>Pool</th>
              <th className={SHEET.thNum}>Merchants</th>
              <th className={SHEET.thNum}>Funded</th>
              <th className={SHEET.thNum}>Commission</th>
            </tr>
          </thead>
          <tbody className={SHEET.tbody}>
            {[...pools.entries()].flatMap(([key, p]) => [
              <tr key={key} className="bg-surface-3/60">
                <td className={cn(SHEET.td, "font-semibold")}>{p.name}</td>
                <td className={cn(SHEET.tdNum, "font-semibold")}>
                  {p.rows.reduce((n, r) => n + r.recovered, 0)}
                </td>
                <td className={cn(SHEET.tdNum, "font-semibold")}>
                  {formatMoneyCompact(p.rows.reduce((n, r) => n + r.funded_cents, 0))}
                </td>
                <td className={cn(SHEET.tdNum, "font-semibold")}>
                  {formatMoneyCompact(p.rows.reduce((n, r) => n + r.commission_cents, 0))}
                </td>
              </tr>,
              ...p.rows.map((r) => (
                <tr key={`${key}:${r.template ?? "none"}`} className={SHEET.tr}>
                  <td className={cn(SHEET.td, "text-text-2 first:pl-8")}>
                    {templateLabel(r.template)}
                  </td>
                  <td className={SHEET.tdNum}>{r.recovered}</td>
                  <td className={SHEET.tdNum}>{formatMoneyCompact(r.funded_cents)}</td>
                  <td className={SHEET.tdNum}>{formatMoneyCompact(r.commission_cents)}</td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      )}
    </Card>
  );
}
