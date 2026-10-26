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
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5">
      <div className="min-w-0">
        <Link
          href={`/clients/${a.clientId}`}
          className="font-medium hover:text-accent hover:underline"
        >
          {a.businessName}
        </Link>
        <p className="text-xs text-muted">
          Funded {formatDate(a.fundedOn, today)} · {formatMoney(a.amountCents)}
          {a.funderName ? ` · ${a.funderName}` : ""} · {plural(row.daysSinceFunded, "day")} ago
        </p>
      </div>
      <div className="flex items-center gap-3">
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
    <Card className="p-4">
      <SectionTitle
        aside={
          <span className="text-sm text-muted tabular-nums">
            {formatMoney(awaiting.totalCents)} expected
          </span>
        }
      >
        Funded, commission not received yet
      </SectionTitle>
      {awaiting.recent.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          Nothing is waiting. Advances funded in the last {AWAITING_WINDOW_DAYS} days with no
          commission recorded show up here.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {awaiting.recent.map((r) => (
            <AwaitingItem key={r.advance.id} row={r} today={today} average={average} />
          ))}
        </ul>
      )}
      {awaiting.older.length > 0 ? (
        <details className="mt-3 border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-text">
            {plural(awaiting.older.length, "older advance")} with no commission recorded
          </summary>
          <p className="mt-1 text-xs text-muted">
            Funded more than {AWAITING_WINDOW_DAYS} days ago. These are not counted as expected — if
            the commission arrived, record it so your totals are complete.
          </p>
          <ul className="mt-1 divide-y divide-border">
            {awaiting.older.map((r) => (
              <AwaitingItem key={r.advance.id} row={r} today={today} average={average} />
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
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
    <Card className="p-4">
      <SectionTitle
        aside={
          <span className="text-sm text-muted tabular-nums">
            ~{formatMoney(pipeline.totalCents)} estimated
          </span>
        }
      >
        Deals close to funding
      </SectionTitle>
      {pipeline.deals.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          No deals at Offers in, Offer presented or Contract out right now.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-border">
          {pipeline.deals.map((d) => (
            <li
              key={d.deal.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`/clients/${d.deal.id}`}
                    className="font-medium hover:text-accent hover:underline"
                  >
                    {d.deal.businessName}
                  </Link>
                  <StageBadge stage={d.deal.stage} />
                </div>
                <p className="text-xs text-muted">
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
      {pipeline.unknown > 0 && pipeline.deals.length > 0 ? (
        <p className="mt-2 text-xs text-muted">
          {plural(pipeline.unknown, "deal")} could not be priced and{" "}
          {pipeline.unknown === 1 ? "is" : "are"} not in the total.
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted">
        {stageDef("offers_in").label}, {stageDef("offer_presented").label} and{" "}
        {stageDef("contract_out").label} deals only.
      </p>
    </Card>
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
    <Card className="p-4">
      <SectionTitle
        aside={
          <Link href="/renewals" className="text-sm font-medium text-accent hover:underline">
            Renewal radar →
          </Link>
        }
      >
        Renewals still to come
      </SectionTitle>
      {forecast.rows.length === 0 ? (
        <EmptyState title="No active advances">
          Once a merchant is funded, the renewal you can expect from them shows up here.
        </EmptyState>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {HORIZONS.map((h) => (
              <div key={h} className="rounded-lg bg-surface-2 p-2.5">
                <dt className="text-xs text-muted">{HORIZON_LABELS[h]}</dt>
                <dd className="text-base font-bold tabular-nums">
                  ~{formatMoney(forecast.byHorizon[h].cents)}
                </dd>
                <dd className="text-xs text-muted">
                  {plural(forecast.byHorizon[h].count, "advance")}
                </dd>
              </div>
            ))}
          </dl>
          {excludedLine(forecast.excluded) ? (
            <p className="mt-2 text-xs text-muted">{excludedLine(forecast.excluded)}</p>
          ) : null}
          <ul className="mt-2 divide-y divide-border">
            {shown.map((r) => (
              <li
                key={r.advance.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2"
              >
                <div className="min-w-0">
                  <Link
                    href={`/clients/${r.advance.clientId}`}
                    className="font-medium hover:text-accent hover:underline"
                  >
                    {r.advance.businessName}
                  </Link>
                  <p className="text-xs text-muted">
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
          {forecast.rows.length > shown.length ? (
            <p className="mt-2 text-xs text-muted">
              Showing the next {shown.length} of {forecast.rows.length}.
            </p>
          ) : null}
          {forecast.unknown > 0 ? (
            <p className="mt-1 text-xs text-muted">
              {plural(forecast.unknown, "advance")} could not be priced and{" "}
              {forecast.unknown === 1 ? "is" : "are"} not in these totals.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
