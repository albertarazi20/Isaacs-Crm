import Link from "next/link";
import { FundedSheet } from "@/components/funded/FundedSheet";
import { ChipLink, ChipRow, PageHeader, SHEET, StatTile } from "@/components/settings/primitives";
import { Card, SectionTitle } from "@/components/ui";
import { requirePage } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { formatMoneyCompact } from "@/lib/money";
import { listFunded, monthTotals } from "@/lib/money/fund";

export const dynamic = "force-dynamic";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const label = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

export default async function FundedPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const { m } = await searchParams;
  const session = await requirePage("/funded");
  const manager = CAN.seeEveryone(session.role);
  const data = await db.withUser(session.userId, async (q) => {
    const ctx = await userContext(q);
    const month = m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : ctx.today.slice(0, 7);
    return { ctx, month, rows: await listFunded(q, month), totals: await monthTotals(q, 12) };
  });
  const { ctx, month, rows, totals } = data;
  const t = totals.find((x) => x.month === month);
  const mine = manager ? rows : rows; // RLS already scoped a rep to their own rows
  const myCut = mine.reduce((n, r) => n + (r.rep_cut_cents ?? 0), 0);
  const gross = mine.reduce((n, r) => n + (r.commission_cents ?? 0), 0);
  const volume = mine.reduce((n, r) => n + r.amount_cents, 0);
  const months = [...new Set([ctx.today.slice(0, 7), ...totals.map((x) => x.month)])]
    .sort()
    .reverse()
    .slice(0, 8);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Funded"
        context="Every advance with its points, PSF, commission and where the money stands. Managers confirm a FUND and record what the lender paid."
      />
      <ChipRow aria-label="Month">
        {months.map((x) => (
          <ChipLink key={x} href={`/funded?m=${x}`} active={x === month}>
            {label(x)}
          </ChipLink>
        ))}
      </ChipRow>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Funded"
          value={formatMoneyCompact(volume)}
          sub={`${rows.length} deal${rows.length === 1 ? "" : "s"}`}
        />
        <StatTile
          label="Commission"
          value={formatMoneyCompact(gross)}
          sub={t?.avg_points ? `${t.avg_points} pts avg` : undefined}
        />
        <StatTile label={manager ? "Rep cuts" : "My cut"} value={formatMoneyCompact(myCut)} />
        <StatTile
          label="Paid by lenders"
          value={formatMoneyCompact(Number(t?.paid_cents ?? 0))}
          tone="good"
        />
        <StatTile
          label="At risk (clawback window)"
          value={formatMoneyCompact(Number(t?.at_risk_cents ?? 0))}
          tone="warn"
        />
        <StatTile
          label="Clawed back"
          value={formatMoneyCompact(Number(t?.clawed_back_cents ?? 0))}
          tone={Number(t?.clawed_back_cents ?? 0) > 0 ? "bad" : undefined}
        />
      </div>
      <FundedSheet rows={rows} manager={manager} today={ctx.today} />
      {totals.length > 1 ? (
        <Card className="min-w-0 overflow-x-auto p-0">
          <div className="px-4 pt-3.5 pb-3">
            <SectionTitle>Last 12 months</SectionTitle>
          </div>
          <table className={SHEET.table}>
            <thead className={SHEET.thead}>
              <tr>
                <th className={SHEET.th}>Month</th>
                <th className={SHEET.thNum}>Deals</th>
                <th className={SHEET.thNum}>Funded</th>
                <th className={SHEET.thNum}>Commission</th>
                <th className={SHEET.thNum}>Rep cuts</th>
                <th className={SHEET.thNum}>Paid</th>
                <th className={SHEET.thNum}>At risk</th>
                <th className={SHEET.thNum}>Avg deal</th>
              </tr>
            </thead>
            <tbody className={SHEET.tbody}>
              {totals.map((x) => (
                <tr key={x.month} className={SHEET.tr}>
                  <td className={SHEET.td}>
                    <Link
                      href={`/funded?m=${x.month}`}
                      className="font-medium whitespace-nowrap hover:underline"
                    >
                      {label(x.month)}
                    </Link>
                  </td>
                  <td className={SHEET.tdNum}>{x.funded_count}</td>
                  <td className={SHEET.tdNum}>{formatMoneyCompact(Number(x.funded_cents))}</td>
                  <td className={SHEET.tdNum}>{formatMoneyCompact(Number(x.commission_cents))}</td>
                  <td className={SHEET.tdNum}>{formatMoneyCompact(Number(x.rep_cut_cents))}</td>
                  <td className={SHEET.tdNum}>{formatMoneyCompact(Number(x.paid_cents))}</td>
                  <td className={SHEET.tdNum}>{formatMoneyCompact(Number(x.at_risk_cents))}</td>
                  <td className={SHEET.tdNum}>
                    {x.avg_deal_cents ? formatMoneyCompact(Number(x.avg_deal_cents)) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </div>
  );
}
