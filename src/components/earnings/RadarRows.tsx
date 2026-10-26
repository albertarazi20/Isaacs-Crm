"use client";

import Link from "next/link";
import { formatDate } from "@/lib/format";
import type { AveragePoints } from "@/lib/earnings/commission";
import type { PaidRow, RadarRow as RadarRowData } from "@/lib/earnings/radar";
import { formatUS } from "@/lib/mca/phone";
import { formatMoney } from "@/lib/money";
import { useApp } from "../app-context";
import { ContactActions } from "../ContactActions";
import { StageBadge } from "../StageBadge";
import { Badge, cn } from "../ui";
import { Commission } from "./bits";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

function agoText(days: number | null): string {
  if (days === null) return "never";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function Header({ card }: { card: RadarRowData["card"] }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/clients/${card.id}`}
          className="text-base font-semibold hover:text-accent hover:underline"
        >
          {card.business_name}
        </Link>
        <StageBadge stage={card.stage} />
      </div>
      <p className="text-sm text-muted">
        {[card.contact_name, card.phone ? formatUS(card.phone) : "", card.industry]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </>
  );
}

/** One merchant at or past their renewal line: how stale the opportunity is and what it is worth. */
export function RadarRow({ row, average }: { row: RadarRowData; average: AveragePoints | null }) {
  const { today } = useApp();
  const { card, progress: p } = row;
  const since = p.crossesOn;
  return (
    <article
      className={cn(
        "rounded-xl border bg-surface p-3.5",
        row.notContactedSinceEligible ? "border-warn/60" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <Header card={card} />
        </div>
        {row.notContactedSinceEligible ? (
          <Badge tone="warn">Not contacted since eligible</Badge>
        ) : null}
      </div>

      <div className="mt-2.5 space-y-1">
        <div
          className="relative h-2 overflow-hidden rounded-full bg-surface-2"
          role="img"
          aria-label={`${p.pct}% paid down`}
        >
          <div
            className="h-full rounded-full bg-good"
            style={{ width: `${Math.min(100, p.pct)}%` }}
          />
          <div
            className="absolute inset-y-0 w-px bg-text/40"
            style={{ left: `${p.thresholdPct}%` }}
            aria-hidden
          />
        </div>
        <p className="text-xs text-muted">
          {p.pct}% paid down · renews from {p.thresholdPct}% ·{" "}
          {formatMoney(row.advance.paymentCents)} {row.advance.frequency} remittance
        </p>
      </div>

      <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Fact label="Eligible">
          {row.eligibleDays === 0 ? "Since today" : plural(row.eligibleDays, "day")}
          {since && row.eligibleDays > 0 ? (
            <span className="font-normal text-muted"> (since {formatDate(since, today)})</span>
          ) : null}
        </Fact>
        <Fact label="Payback outstanding">{formatMoney(p.balanceCents)}</Fact>
        <Fact label="Renewal commission">
          <Commission
            value={row.expected}
            average={average}
            amountCents={row.advance.amountCents}
          />
        </Fact>
        <Fact label="Last contact">
          {row.lastContactOn === null ? (
            <span className="text-warn">Never</span>
          ) : (
            <>
              {agoText(row.daysSinceContact)}
              <span className="font-normal text-muted">
                {" "}
                ({formatDate(row.lastContactOn, today)})
              </span>
            </>
          )}
        </Fact>
      </dl>

      <div className="mt-3">
        <ContactActions client={card} />
      </div>
    </article>
  );
}

/** A merchant who has paid off: the hottest lead in the shop for the first 30 days. */
export function PaidInFullRow({ row, average }: { row: PaidRow; average: AveragePoints | null }) {
  const { today } = useApp();
  const { card, advance } = row;
  return (
    <article
      className={cn(
        "rounded-xl border bg-surface p-3.5",
        row.hot ? "border-good/60" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <Header card={card} />
        </div>
        <div className="flex items-center gap-2">
          {row.hot ? <Badge tone="good">Hot</Badge> : null}
          <Badge tone="neutral">
            Paid off{" "}
            {row.daysSincePaidOff === 0 ? "today" : `${plural(row.daysSincePaidOff, "day")} ago`}
          </Badge>
        </div>
      </div>
      <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Fact label="Last advance">
          {advance ? (
            <>
              {formatMoney(advance.amountCents)}
              {advance.funderName ? (
                <span className="font-normal text-muted"> · {advance.funderName}</span>
              ) : null}
            </>
          ) : (
            "—"
          )}
        </Fact>
        <Fact label="Renewal commission">
          <Commission
            value={row.expected}
            average={average}
            amountCents={advance?.amountCents}
            none="Not priced yet"
          />
        </Fact>
        <Fact label="Last contact">
          {row.lastContactOn === null ? (
            <span className="text-warn">Never</span>
          ) : (
            <>
              {agoText(row.daysSinceContact)}
              <span className="font-normal text-muted">
                {" "}
                ({formatDate(row.lastContactOn, today)})
              </span>
            </>
          )}
        </Fact>
        <Fact label="Next date">
          {card.next_due_on ? formatDate(card.next_due_on, today) : "—"}
        </Fact>
      </dl>
      <div className="mt-3">
        <ContactActions client={card} />
      </div>
    </article>
  );
}
