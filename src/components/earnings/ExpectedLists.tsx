import Link from "next/link";
import type { AveragePoints } from "@/lib/earnings/commission";
import { excludedLine } from "@/lib/earnings/eligible";
import {
  AWAITING_WINDOW_DAYS,
  HORIZON_LABELS,
  type Awaiting,
  type AwaitingRow,
  type Horizon,
  type Pipeline,
  type RenewalForecast,
} from "@/lib/earnings/expected";
import { formatDate } from "@/lib/format";
import type { ISODate } from "@/lib/mca/dates";
import { stageDef } from "@/lib/mca/stages";
import { formatMoney } from "@/lib/money";
import { StageBadge } from "../StageBadge";
import { Card, EmptyState, SectionTitle } from "../ui";
import { Commission } from "./bits";
import { RecordCommission } from "./RecordCommission";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A compact list card: title and aside in the head, rows edge to edge under a hairline. */
function ListCard({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="min-w-0 p-0">
      <div className="px-4 pt-3.5 pb-3">
        <SectionTitle aside={aside}>{title}</SectionTitle>
      </div>
      {children}
    </Card>
  );
}

function AwaitingItem({
  row,
  today,
  average,
}: {
  row: AwaitingRow;
  today: ISODate;
  average: AveragePoints | null;
}) {
  const a = row.advance;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 transition hover:bg-surface-3">
      <div className="min-w-0 flex-1 basis-56">
        <Link
          href={`/clients/${a.clientId}`}
          className="block truncate text-sm font-semibold hover:underline"
        >
          {a.businessName}
        </Link>
        <p className="truncate text-xs text-muted">
          Funded {formatDate(a.fundedOn, today)} · {formatMoney(a.amountCents)}
          {a.funderName ? ` · ${a.funderName}` : ""} · {plural(row.daysSinceFunded, "day")} ago
        </p>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <span className="text-sm font-semibold tabular-nums">
          <Commission value={row.expected} average={average} amountCents={a.amountCents} />
        </span>
        <RecordCommission
          fundingId={a.id}
          businessName={a.businessName}
          suggestedCents={row.expected?.cents ?? null}
        />
      </div>
    </li>
  );
}

export function AwaitingList({
  awaiting,
  today,
  average,
}: {
  awaiting: Awaiting;
  today: ISODate;
  average: AveragePoints | null;
}) {
  return (
    <ListCard
      title="Funded, commission not received yet"
      aside={
        <span className="text-xs text-muted tabular-nums">
          {formatMoney(awaiting.totalCents)} expected
        </span>
      }
    >
      {awaiting.recent.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted">
          Nothing is waiting. Advances funded in the last {AWAITING_WINDOW_DAYS} days with no
          commission recorded show up here.
        </p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {awaiting.recent.map((r) => (
            <AwaitingItem key={r.advance.id} row={r} today={today} average={average} />
          ))}
        </ul>
      )}
      {awaiting.older.length > 0 ? (
        <details className="border-t border-border">
          <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium text-muted transition hover:text-text">
            {plural(awaiting.older.length, "older advance")} with no commission recorded
          </summary>
          <p className="px-4 pb-2 text-xs text-muted">
            Funded more than {AWAITING_WINDOW_DAYS} days ago. These are not counted as expected — if
            the commission arrived, record it so your totals are complete.
          </p>
          <ul className="divide-y divide-border border-t border-border">
            {awaiting.older.map((r) => (
              <AwaitingItem key={r.advance.id} row={r} today={today} average={average} />
            ))}
          </ul>
        </details>
      ) : null}
    </ListCard>
  );
}

export function PipelineList({
  pipeline,
  average,
}: {
  pipeline: Pipeline;
  average: AveragePoints | null;
}) {
  return (
    <ListCard
      title="Deals close to funding"
      aside={
        <span className="text-xs text-muted tabular-nums">
          ~{formatMoney(pipeline.totalCents)} estimated
        </span>
      }
    >
      {pipeline.deals.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted">
          No deals at Offers in, Offer presented or Contract out right now.
        </p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {pipeline.deals.map((d) => (
            <li
              key={d.deal.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5 transition hover:bg-surface-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Link
                    href={`/clients/${d.deal.id}`}
                    className="truncate text-sm font-semibold hover:underline"
                  >
                    {d.deal.businessName}
                  </Link>
                  <StageBadge stage={d.deal.stage} />
                </div>
                <p className="truncate text-xs text-muted">
                  {d.amountCents === null
                    ? "No offer and no approval estimate yet — add one on the client page"
                    : d.amountFrom === "offer"
                      ? `Best offer ${formatMoney(d.amountCents)}${d.funderName ? ` from ${d.funderName}` : ""}`
                      : `Approval estimate ${formatMoney(d.amountCents)}`}
                </p>
              </div>
              <span className="text-sm font-semibold tabular-nums">
                <Commission
                  value={d.expected}
                  average={average}
                  amountCents={d.amountCents ?? undefined}
                  none={d.amountCents === null ? "No amount yet" : "Not priced yet"}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-1 border-t border-border px-4 py-2.5 text-xs text-muted">
        {pipeline.unknown > 0 && pipeline.deals.length > 0 ? (
          <p>
            {plural(pipeline.unknown, "deal")} could not be priced and{" "}
            {pipeline.unknown === 1 ? "is" : "are"} not in the total.
          </p>
        ) : null}
        <p>
          {stageDef("offers_in").label}, {stageDef("offer_presented").label} and{" "}
          {stageDef("contract_out").label} deals only.
        </p>
      </div>
    </ListCard>
  );
}

const HORIZONS: Horizon[] = ["now", "30", "90", "later"];

export function RenewalForecastPanel({
  forecast,
  today,
  average,
}: {
  forecast: RenewalForecast;
  today: ISODate;
  average: AveragePoints | null;
}) {
  const shown = forecast.rows.slice(0, 8);
  return (
    <ListCard
      title="Renewals still to come"
      aside={
        <Link href="/renewals" className="text-xs font-medium text-accent hover:underline">
          Renewal radar →
        </Link>
      }
    >
      {forecast.rows.length === 0 ? (
        <div className="px-4 pb-4">
          <EmptyState title="No active advances">
            Once a merchant is funded, the renewal you can expect from them shows up here.
          </EmptyState>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-4">
            {HORIZONS.map((h) => (
              <div key={h} className="bg-surface px-4 py-3">
                <dt className="text-[11px] font-semibold tracking-wide text-muted uppercase">
                  {HORIZON_LABELS[h]}
                </dt>
                <dd className="mt-0.5 text-lg font-semibold tabular-nums">
                  ~{formatMoney(forecast.byHorizon[h].cents)}
                </dd>
                <dd className="text-xs text-muted">
                  {plural(forecast.byHorizon[h].count, "advance")}
                </dd>
              </div>
            ))}
          </dl>
          {excludedLine(forecast.excluded) ? (
            <p className="border-t border-border px-4 py-2 text-xs text-muted">
              {excludedLine(forecast.excluded)}
            </p>
          ) : null}
          <ul className="divide-y divide-border border-t border-border">
            {shown.map((r) => (
              <li
                key={r.advance.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5 transition hover:bg-surface-3"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/clients/${r.advance.clientId}`}
                    className="block truncate text-sm font-semibold hover:underline"
                  >
                    {r.advance.businessName}
                  </Link>
                  <p className="truncate text-xs text-muted">
                    {r.renewalOn <= today ? "Ready now" : `Ready ${formatDate(r.renewalOn, today)}`}{" "}
                    · {r.pct}% paid down · {formatMoney(r.advance.amountCents)} again
                  </p>
                </div>
                <span className="text-sm font-semibold tabular-nums">
                  <Commission
                    value={r.expected}
                    average={average}
                    amountCents={r.advance.amountCents}
                  />
                </span>
              </li>
            ))}
          </ul>
          {forecast.rows.length > shown.length || forecast.unknown > 0 ? (
            <div className="space-y-1 border-t border-border px-4 py-2.5 text-xs text-muted">
              {forecast.rows.length > shown.length ? (
                <p>
                  Showing the next {shown.length} of {forecast.rows.length}.
                </p>
              ) : null}
              {forecast.unknown > 0 ? (
                <p>
                  {plural(forecast.unknown, "advance")} could not be priced and{" "}
                  {forecast.unknown === 1 ? "is" : "are"} not in these totals.
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </ListCard>
  );
}
