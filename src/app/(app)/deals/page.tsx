import Link from "next/link";
import { DealStatusBadge, FilterChip, PageHeader, TD, TH } from "@/components/deals/primitives";
import { Card, EmptyState, LinkButton } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { dealStatusCounts, isDealFilter, listDeals } from "@/lib/deals/queries";
import { DEAL_STATUS_LABELS, type DealCard, type DealFilter } from "@/lib/deals/types";
import { db } from "@/lib/db";
import { timeAgo } from "@/lib/format";
import { formatMoneyCompact } from "@/lib/money";
import { requestTimeMs } from "@/lib/server-time";

export const dynamic = "force-dynamic";

/** The chips, in the order a rep thinks: what is live, then where it is, then how it ended. */
const CHIPS: { key: DealFilter; label: string }[] = [
  { key: "live", label: "Working on" },
  { key: "needs_pitch", label: "Approved" },
  { key: "pitched", label: "Presented" },
  { key: "pending_lenders", label: "With lenders" },
  { key: "stips_needed", label: "Stips needed" },
  { key: "kicked_back", label: "Kicked back" },
  { key: "expiring", label: "Expiring" },
  { key: "funded", label: "Funded" },
  { key: "reshop", label: "Eligible to reshop" },
  { key: "declined", label: "Declined" },
  { key: "all", label: "Everything" },
];

function Row({ d, manager, nowMs }: { d: DealCard; manager: boolean; nowMs: number }) {
  return (
    <tr className="transition hover:bg-surface-3">
      <td className={`${TD} py-0`}>
        <Link href={`/deals/${d.id}`} className="block min-w-48 py-2.5 sm:py-2">
          <span className="block truncate font-semibold">{d.business_name}</span>
          <span className="block truncate text-xs text-muted">
            D-{d.number} · {d.contact_name || d.email || d.phone}
            {manager ? ` · ${d.rep_name}` : ""}
          </span>
        </Link>
      </td>
      <td className={TD}>
        <DealStatusBadge status={d.status} label={DEAL_STATUS_LABELS[d.status]} />
        {d.blocker ? (
          <span className="mt-0.5 block max-w-64 truncate text-xs text-muted">{d.blocker}</span>
        ) : null}
      </td>
      <td className={`${TD} text-right tabular-nums`}>
        {d.requested_cents ? formatMoneyCompact(d.requested_cents) : "—"}
      </td>
      <td className={`${TD} text-right whitespace-nowrap tabular-nums`}>
        {d.lenders_sent > 0 ? (
          <span>
            {d.lenders_approved > 0 ? (
              <span className="text-good">{d.lenders_approved} ✓</span>
            ) : null}
            {d.lenders_declined > 0 ? (
              <span className="ml-1 text-bad">{d.lenders_declined} ✗</span>
            ) : null}
            <span className="ml-1 text-muted">/ {d.lenders_sent}</span>
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className={`${TD} text-right whitespace-nowrap tabular-nums`}>
        {d.funded_cents ? (
          <span className="font-semibold text-good">{formatMoneyCompact(d.funded_cents)}</span>
        ) : d.best_offer_cents ? (
          <span>
            {formatMoneyCompact(d.best_offer_cents)}{" "}
            <span className="text-muted">at {d.best_factor_rate}</span>
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </td>
      <td className={`${TD} text-right text-xs whitespace-nowrap text-muted`}>
        {d.last_activity_at ? timeAgo(d.last_activity_at, new Date(nowMs)) : "—"}
      </td>
    </tr>
  );
}

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ f?: string }>;
}) {
  const { f } = await searchParams;
  const filter: DealFilter = f && isDealFilter(f) ? f : "live";
  const session = await requireSession();
  const manager = CAN.seeEveryone(session.role);
  const { deals, counts } = await db.withUser(session.userId, async (q) => ({
    deals: await listDeals(q, filter),
    counts: await dealStatusCounts(q),
  }));
  const nowMs = requestTimeMs();
  const countFor = (key: DealFilter): number | null => {
    if (key === "live")
      return Object.entries(counts)
        .filter(([k]) => !["funded", "declined", "lost", "dead"].includes(k))
        .reduce((n, [, v]) => n + v, 0);
    if (key === "all") return Object.values(counts).reduce((n, v) => n + v, 0);
    if (key === "reshop") return counts["declined_by_all"] ?? null;
    return counts[key] ?? null;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={manager ? "Deals" : "My Deals"}
        context="Every file you ever submitted — kickbacks, approvals, declines and fundings included."
        actions={
          <LinkButton href="/lead-intake" variant="primary">
            + New lead
          </LinkButton>
        }
      />
      <nav aria-label="Filter" className="flex flex-wrap gap-1.5">
        {CHIPS.map((c) => (
          <FilterChip
            key={c.key}
            href={c.key === "live" ? "/deals" : `/deals?f=${c.key}`}
            active={c.key === filter}
            count={countFor(c.key)}
          >
            {c.label}
          </FilterChip>
        ))}
      </nav>
      {deals.length === 0 ? (
        <EmptyState title="No deals here">
          {filter === "live"
            ? "Submit a lead to ops from the merchant page and it shows up here."
            : "Nothing matches this filter."}
        </EmptyState>
      ) : (
        <Card className="min-w-0 overflow-x-auto p-0">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-2/60">
              <tr>
                <th className={TH}>Merchant</th>
                <th className={TH}>Where it is</th>
                <th className={`${TH} text-right`}>Asked</th>
                <th className={`${TH} text-right`}>Lenders</th>
                <th className={`${TH} text-right`}>Best / funded</th>
                <th className={`${TH} text-right`}>Last touch</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {deals.map((d) => (
                <Row key={d.id} d={d} manager={manager} nowMs={nowMs} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
