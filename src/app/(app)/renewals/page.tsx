import Link from "next/link";
import { PastPayoffPrompt } from "@/components/earnings/PastPayoffPrompt";
import { PaidInFullRow, RadarRow } from "@/components/earnings/RadarRows";
import { buttonClass, cn, EmptyState, SectionTitle } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { loadEarningsData } from "@/lib/earnings/queries";
import { excludedLine } from "@/lib/earnings/eligible";
import { buildRadar } from "@/lib/earnings/radar";
import { funderThresholdMap } from "@/lib/earnings/progress";
import { commissionContext } from "@/lib/earnings/view";
import { formatMoney } from "@/lib/money";

const THRESHOLDS = [50, 60, 70, 80, 90];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default async function RenewalsPage({
  searchParams,
}: {
  searchParams: Promise<{ min?: string }>;
}) {
  const { min } = await searchParams;
  /** null = no ?min=: each funder's own renewal line, else 50%. */
  const minPct = THRESHOLDS.includes(Number(min)) ? Number(min) : null;
  const session = await requireSession();
  const { data, ctx } = await db.withUser(session.userId, async (q) => ({
    ctx: await userContext(q),
    data: await loadEarningsData(q),
  }));
  const thresholds = funderThresholdMap(data.funders);
  const commission = commissionContext(data);
  const radar = buildRadar({
    cards: data.cards,
    advances: data.advances,
    today: ctx.today,
    timezone: ctx.timezone,
    minPct,
    thresholds,
    commission,
  });
  const ownLines = thresholds.size > 0;
  const chips: { label: string; href: string; active: boolean }[] = [
    ...(ownLines
      ? [{ label: "Each funder's own", href: "/renewals", active: minPct === null }]
      : []),
    ...THRESHOLDS.map((p) => ({
      label: `${p}%`,
      href: `/renewals?min=${p}`,
      active: minPct === null ? !ownLines && p === 50 : p === minPct,
    })),
  ];
  const { totals } = radar;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Renewals</h1>
          <p className="text-sm text-muted">
            Merchants paid down enough to offer a renewal, hottest first. Your best leads.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <nav aria-label="Paid down at least" className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm text-muted">Paid down at least</span>
            {chips.map((c) => (
              <Link
                key={c.label}
                href={c.href}
                aria-current={c.active ? "page" : undefined}
                className={cn(
                  "rounded-lg border px-2.5 py-1 text-sm font-medium",
                  c.active
                    ? "border-accent bg-accent text-accent-fg"
                    : "border-border bg-surface hover:bg-surface-2",
                )}
              >
                {c.label}
              </Link>
            ))}
          </nav>
          <Link href="/earnings" className={buttonClass("secondary", "md")}>
            Earnings →
          </Link>
        </div>
      </div>

      <PastPayoffPrompt rows={radar.pastPayoff} />

      <section className="space-y-2">
        <SectionTitle
          aside={
            <span className="text-right text-sm text-muted">
              {formatMoney(totals.outstandingCents)} payback outstanding
              {radar.ready.length > 0 ? (
                <>
                  {" · "}~{formatMoney(totals.expectedCents)} renewal commission
                  {totals.expectedUnknown > 0 ? ` (${totals.expectedUnknown} not priced)` : ""}
                </>
              ) : null}
            </span>
          }
        >
          Ready to renew ({radar.ready.length})
        </SectionTitle>
        {totals.neverContacted > 0 ? (
          <p className="text-sm text-warn">
            {plural(totals.neverContacted, "merchant")} not contacted since becoming eligible.
          </p>
        ) : null}
        {excludedLine(radar.excluded) ? (
          <p className="text-sm text-muted">{excludedLine(radar.excluded)}</p>
        ) : null}
        {radar.ready.length === 0 ? (
          <EmptyState
            title={
              minPct === null
                ? "Nobody has reached their renewal line yet"
                : `Nobody is ${minPct}% paid down yet`
            }
          >
            Funded merchants show up here the day they cross the line.
          </EmptyState>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {radar.ready.map((r) => (
              <RadarRow key={r.card.id} row={r} average={commission.average} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <SectionTitle>Paid in full ({radar.paidInFull.length})</SectionTitle>
        {radar.paidInFull.length === 0 ? (
          <EmptyState title="Nobody has paid off yet" />
        ) : (
          <>
            <p className="text-sm text-muted">
              Newest first. The first 30 days after a merchant pays off are the best time to call.
            </p>
            <div className="grid gap-3 xl:grid-cols-2">
              {radar.paidInFull.map((r) => (
                <PaidInFullRow key={r.card.id} row={r} average={commission.average} />
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
