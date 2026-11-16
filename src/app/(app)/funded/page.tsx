import Link from "next/link";
import { FundedSheet } from "@/components/funded/FundedSheet";
import { Card, SectionTitle, cn } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
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
  const session = await requireSession();
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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Funded</h1>
          <p className="text-sm text-muted">
            Every advance with its points, PSF, commission and where the money stands. Managers
            confirm a FUND and record what the lender paid.
          </p>
        </div>
        <nav aria-label="Month" className="flex flex-wrap gap-1.5">
          {[...new Set([ctx.today.slice(0, 7), ...totals.map((x) => x.month)])]
            .sort()
            .reverse()
            .slice(0, 8)
            .map((x) => (
              <Link
                key={x}
                href={`/funded?m=${x}`}
                aria-current={x === month ? "page" : undefined}
                className={cn(
                  "rounded-full border px-3 py-1 text-sm",
                  x === month
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border text-muted hover:text-text",
                )}
              >
                {label(x)}
              </Link>
            ))}
        </nav>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Tile
          label="Funded"
          value={formatMoneyCompact(volume)}
          sub={`${rows.length} deal${rows.length === 1 ? "" : "s"}`}
        />
        <Tile
          label="Commission"
          value={formatMoneyCompact(gross)}
          sub={t?.avg_points ? `${t.avg_points} pts avg` : undefined}
        />
        <Tile label={manager ? "Rep cuts" : "My cut"} value={formatMoneyCompact(myCut)} />
        <Tile
          label="Paid by lenders"
          value={formatMoneyCompact(Number(t?.paid_cents ?? 0))}
          tone="good"
        />
        <Tile
          label="At risk (clawback window)"
          value={formatMoneyCompact(Number(t?.at_risk_cents ?? 0))}
          tone="warn"
        />
        <Tile
          label="Clawed back"
          value={formatMoneyCompact(Number(t?.clawed_back_cents ?? 0))}
          tone={Number(t?.clawed_back_cents ?? 0) > 0 ? "bad" : undefined}
        />
      </div>
      <FundedSheet rows={rows} manager={manager} today={ctx.today} />
      {totals.length > 1 ? (
        <Card className="overflow-x-auto p-0">
          <div className="px-4 pt-4">
            <SectionTitle>Last 12 months</SectionTitle>
          </div>
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Month</th>
                <th className="px-2 py-2 text-right font-medium">Deals</th>
                <th className="px-2 py-2 text-right font-medium">Funded</th>
                <th className="px-2 py-2 text-right font-medium">Commission</th>
                <th className="px-2 py-2 text-right font-medium">Rep cuts</th>
                <th className="px-2 py-2 text-right font-medium">Paid</th>
                <th className="px-2 py-2 text-right font-medium">At risk</th>
                <th className="px-4 py-2 text-right font-medium">Avg deal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {totals.map((x) => (
                <tr key={x.month}>
                  <td className="px-4 py-2">
                    <Link href={`/funded?m=${x.month}`} className="hover:underline">
                      {label(x.month)}
                    </Link>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{x.funded_count}</td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {formatMoneyCompact(Number(x.funded_cents))}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {formatMoneyCompact(Number(x.commission_cents))}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {formatMoneyCompact(Number(x.rep_cut_cents))}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {formatMoneyCompact(Number(x.paid_cents))}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {formatMoneyCompact(Number(x.at_risk_cents))}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
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

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "good" | "warn" | "bad";
}) {
  const color =
    tone === "bad"
      ? "text-bad"
      : tone === "warn"
        ? "text-warn"
        : tone === "good"
          ? "text-good"
          : "";
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</p>
      <p className={cn("mt-1 text-2xl font-bold tabular-nums", color)}>{value}</p>
      {sub ? <p className="text-xs text-muted">{sub}</p> : null}
    </div>
  );
}
