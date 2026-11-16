import { notFound } from "next/navigation";
import { PrintButton } from "@/components/funded/PrintButton";
import { PageHeader, SHEET } from "@/components/settings/primitives";
import { Badge, Card, EmptyState, LinkButton, cn } from "@/components/ui";
import { CAN } from "@/lib/auth/roles";
import { requirePage } from "@/lib/auth/server";
import { userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { KIND_WORDS, periodLabel } from "@/lib/money/close";
import { statementsForPeriod } from "@/lib/money/fundedExtras";

export const dynamic = "force-dynamic";

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * One month's commission statements, readable and printable. A rep sees their own; a manager sees everyone's, one
 * block per person. The print: variants drop the app's chrome and the buttons, so the paper is the statement.
 */
export default async function StatementPage({ params }: { params: Promise<{ period: string }> }) {
  const { period } = await params;
  if (!PERIOD.test(period)) notFound();
  const session = await requirePage("/funded");
  const manager = CAN.seeEveryone(session.role);
  const { ctx, found } = await db.withUser(session.userId, async (q) => ({
    ctx: await userContext(q),
    found: await statementsForPeriod(q, period),
  }));
  const label = periodLabel(`${period}-01`);
  return (
    <div className="space-y-5 print:space-y-4">
      {/* The app's header and tab bar are the layout's; paper gets only the statement. */}
      <style>{`@media print { [data-app-header], nav[aria-label="Main"], nav[aria-label="Primary"] { display: none !important; } main { padding: 0 !important; } }`}</style>
      <PageHeader
        title={`${label} statement`}
        context={
          found?.closed_at
            ? `Closed ${formatDate(found.closed_at.slice(0, 10), ctx.today)}. Lines in a closed month never change; a correction is a new dated line in the month after.`
            : "This month is not closed yet."
        }
        actions={
          <div className="flex items-center gap-2 print:hidden">
            <LinkButton href="/funded">Back to Funded</LinkButton>
            {found ? <PrintButton /> : null}
          </div>
        }
      />
      {!found ? (
        <EmptyState title={`No statement for ${label}`}>
          A statement exists once a manager closes the month and the month had commission lines.
        </EmptyState>
      ) : (
        found.statements.map((s) => (
          <Card
            key={s.id}
            className="min-w-0 overflow-x-auto p-0 print:overflow-visible print:rounded-none print:border-0 print:shadow-none"
          >
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 px-4 pt-4 pb-3">
              <div className="min-w-0">
                <h2 className="text-base font-semibold">{s.name}</h2>
                <p className="text-xs text-muted">
                  {s.line_count} line{s.line_count === 1 ? "" : "s"} · {label}
                </p>
              </div>
              <dl className="flex gap-6 text-right">
                <div>
                  <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                    Gross
                  </dt>
                  <dd className="text-lg font-semibold tabular-nums">
                    {formatMoney(s.gross_cents)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                    {manager ? "Rep cut" : "Your cut"}
                  </dt>
                  <dd className="text-lg font-semibold tabular-nums">{formatMoney(s.rep_cents)}</dd>
                </div>
                {manager ? (
                  <div>
                    <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                      House
                    </dt>
                    <dd className="text-lg font-semibold tabular-nums">
                      {formatMoney(s.house_cents)}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
            <table className={SHEET.table}>
              <thead className={SHEET.thead}>
                <tr>
                  <th className={SHEET.th}>Merchant</th>
                  <th className={SHEET.th}>Line</th>
                  <th className={SHEET.thNum}>Gross</th>
                  <th className={SHEET.thNum}>{manager ? "Rep cut" : "Your cut"}</th>
                  {manager ? <th className={SHEET.thNum}>House</th> : null}
                </tr>
              </thead>
              <tbody className={SHEET.tbody}>
                {s.lines.map((l) => (
                  <tr key={l.id} className={SHEET.tr}>
                    <td className={SHEET.td}>
                      <span className="block font-medium">{l.business}</span>
                      <span className="block text-xs text-muted">
                        {l.funder ? `${l.funder} · ` : ""}funded{" "}
                        {formatDate(l.funded_on, ctx.today)}
                      </span>
                    </td>
                    <td className={SHEET.td}>
                      <Badge
                        tone={l.kind === "correction" || l.kind === "clawback" ? "warn" : "neutral"}
                      >
                        {KIND_WORDS[l.kind] ?? l.kind}
                      </Badge>
                      {l.note ? (
                        <span className="mt-0.5 block max-w-md text-xs text-muted">{l.note}</span>
                      ) : null}
                    </td>
                    <td className={SHEET.tdNum}>{formatMoney(l.gross_cents)}</td>
                    <td className={cn(SHEET.tdNum, "font-semibold")}>{formatMoney(l.rep_cents)}</td>
                    {manager ? <td className={SHEET.tdNum}>{formatMoney(l.house_cents)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))
      )}
    </div>
  );
}
