import Image from "next/image";
import Link from "next/link";
import { MonthChart } from "@/components/earnings/MonthChart";
import { MonthTable } from "@/components/earnings/MonthTable";
import {
  AwaitingList,
  PipelineList,
  RenewalForecastPanel,
} from "@/components/earnings/ExpectedLists";
import { PriceBook } from "@/components/earnings/PriceBook";
import { Tile } from "@/components/earnings/bits";
import { buttonClass, Card, EmptyState, SectionTitle } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { formatPoints } from "@/lib/earnings/commission";
import { loadEarningsData } from "@/lib/earnings/queries";
import { buildEarnings } from "@/lib/earnings/view";
import { formatMoney } from "@/lib/money";

const DELI_MONTH_CENTS = 400_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default async function EarningsPage() {
  const session = await requireSession();
  const { data, ctx } = await db.withUser(session.userId, async (q) => ({
    ctx: await userContext(q),
    data: await loadEarningsData(q),
  }));
  const v = buildEarnings(data, ctx.today);
  const { summary, average } = v;
  const estimateTip = average ? (
    <>
      Estimate = the advance amount (the best offer, or the amount you expect the merchant to be
      approved for) × your average <strong>{formatPoints(average.points)} points</strong>, taken
      from {plural(average.n, "advance")} with a commission on record. Enter more commissions and it
      sharpens.
    </>
  ) : (
    <>
      No advance has a commission entered yet, so there is nothing to base an estimate on. Enter the
      commission on a funded advance (Update on its Funding card).
    </>
  );

  return (
    <div className="space-y-6">
      <Card className="flex items-center gap-4 p-4">
        <Image
          src="/deli-guys.png"
          alt="Two deli guys holding a loaded sandwich"
          width={474}
          height={842}
          className="h-32 w-auto shrink-0 rounded-lg object-cover"
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Deli guys make $4k a month. Goal: beat that.</p>
          <div
            className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            aria-label="This month against the deli guy's $4,000"
            aria-valuemin={0}
            aria-valuemax={DELI_MONTH_CENTS}
            aria-valuenow={Math.min(summary.thisMonthCents, DELI_MONTH_CENTS)}
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{
                width: `${Math.min(100, Math.max(0, (summary.thisMonthCents / DELI_MONTH_CENTS) * 100))}%`,
              }}
            />
          </div>
          <p className="mt-1 text-xs text-muted">
            {summary.thisMonthCents >= DELI_MONTH_CENTS
              ? `${formatMoney(summary.thisMonthCents)} this month. Deli guy beaten.`
              : `${formatMoney(summary.thisMonthCents)} of ${formatMoney(DELI_MONTH_CENTS)} this month`}
          </p>
        </div>
      </Card>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Earnings</h1>
          <p className="text-sm text-muted">
            What you have earned in commission, and what is on its way.
          </p>
        </div>
        <Link href="/renewals" className={buttonClass("secondary", "md")}>
          Renewal radar →
        </Link>
      </div>

      <section aria-labelledby="received" className="space-y-2">
        <SectionTitle>
          <span id="received">Received</span>
        </SectionTitle>
        <div className="grid gap-3 sm:grid-cols-3">
          <Tile
            label="This month"
            value={formatMoney(summary.thisMonthCents)}
            note={
              summary.thisMonthCount > 0
                ? `${summary.thisMonthCount} received`
                : "Nothing recorded yet this month"
            }
          />
          <Tile
            label="Last month"
            value={formatMoney(summary.lastMonthCents)}
            note={
              summary.lastMonthCount > 0
                ? `${summary.lastMonthCount} received`
                : "Nothing recorded last month"
            }
          />
          <Tile
            label="Year to date"
            value={formatMoney(summary.ytdCents)}
            note={
              summary.ytdCount > 0 ? `${summary.ytdCount} received` : "Nothing recorded this year"
            }
          />
        </div>
        {summary.entries === 0 ? (
          <p className="text-sm text-muted">
            {v.advanceCount === 0
              ? "No advance has been funded yet. Fund a deal and enter the commission when it arrives."
              : "No commission has been recorded yet. Use “Record received” below, or Update on a merchant's Funding card, when the funder pays you."}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="expected" className="space-y-2">
        <SectionTitle>
          <span id="expected">Expected</span>
        </SectionTitle>
        <div className="grid gap-3 sm:grid-cols-3">
          <Tile
            label="Funded, not yet received"
            value={formatMoney(v.awaiting.totalCents)}
            estimate={v.awaiting.estimated > 0}
            note={`${plural(v.awaiting.recent.length, "advance")} funded in the last 90 days${v.awaiting.unknown > 0 ? ` · ${v.awaiting.unknown} not priced` : ""}`}
            tip={
              <>
                Advances funded in the last 90 days with no commission received on record. Each is
                worth the commission you entered; if none is entered, the funder&apos;s points or
                your average points × the advance. {v.awaiting.estimated > 0 ? estimateTip : null}
              </>
            }
          />
          <Tile
            label="Deals close to funding"
            value={`~${formatMoney(v.pipeline.totalCents)}`}
            estimate
            note={`${plural(v.pipeline.deals.length, "deal")} at Offers in, Offer presented or Contract out${v.pipeline.unknown > 0 ? ` · ${v.pipeline.unknown} not priced` : ""}`}
            tip={<>{estimateTip}</>}
          />
          <Tile
            label="Renewals still to come"
            value={`~${formatMoney(v.renewals.totalCents)}`}
            estimate
            note={`${plural(v.renewals.rows.length, "active advance")}, renewed at the same terms${v.renewals.unknown > 0 ? ` · ${v.renewals.unknown} not priced` : ""}`}
            tip={
              <>
                Each active advance, renewed for the same amount at the same commission, the day it
                crosses its renewal line (50% paid down unless the funder says otherwise).{" "}
                {estimateTip}
              </>
            }
          />
        </div>
      </section>

      <Card className="p-4">
        <SectionTitle
          aside={<span className="text-sm text-muted">Last 12 months · commission received</span>}
        >
          Month by month
        </SectionTitle>
        <div className="mt-3 grid gap-6 lg:grid-cols-2">
          <div className="min-w-0">
            {summary.entries === 0 ? (
              <EmptyState title="Nothing to chart yet">
                Once you record commission received, each month shows up here as a bar.
              </EmptyState>
            ) : (
              <MonthChart months={v.months} />
            )}
          </div>
          <MonthTable months={v.months} />
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <AwaitingList awaiting={v.awaiting} today={ctx.today} average={average} />
        <PipelineList pipeline={v.pipeline} average={average} />
      </div>
      <RenewalForecastPanel forecast={v.renewals} today={ctx.today} average={average} />

      <PriceBook
        observations={v.price.observations}
        loss={v.price.loss}
        hasOffers={v.price.hasOffers}
      />
    </div>
  );
}
