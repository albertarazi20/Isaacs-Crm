import Link from "next/link";
import { Card, EmptyState, cn } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import { dealStatusCounts, isDealFilter, listDeals } from "@/lib/deals/queries";
import {
  DEAL_STATUS_LABELS,
  type DealCard,
  type DealFilter,
  type DealStatus,
} from "@/lib/deals/types";
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

const STATUS_TONE: Partial<Record<DealStatus, string>> = {
  kicked_back: "bg-bad-soft text-bad",
  needs_pitch: "bg-good-soft text-good",
  pitched: "bg-good-soft text-good",
  funded: "bg-good-soft text-good",
  stips_needed: "bg-warn-soft text-warn",
  declined_by_all: "bg-bad-soft text-bad",
  declined: "bg-surface-2 text-muted",
  lost: "bg-surface-2 text-muted",
  dead: "bg-surface-2 text-muted",
};

function Row({ d, manager, nowMs }: { d: DealCard; manager: boolean; nowMs: number }) {
  return (
    <tr className="hover:bg-surface-2/60">
      <td className="px-4 py-2.5">
        <Link href={`/deals/${d.id}`} className="block">
          <span className="block font-semibold">{d.business_name}</span>
          <span className="block text-xs text-muted">
            D-{d.number} · {d.contact_name || d.email || d.phone}
            {manager ? ` · ${d.rep_name}` : ""}
          </span>
        </Link>
      </td>
      <td className="px-2 py-2.5">
        <span
          className={cn(
            "rounded-md px-2 py-0.5 text-xs font-semibold",
            STATUS_TONE[d.status] ?? "bg-accent-soft text-accent",
          )}
        >
          {DEAL_STATUS_LABELS[d.status]}
        </span>
        {d.blocker ? (
          <span className="mt-0.5 block max-w-[260px] truncate text-xs text-muted">
            {d.blocker}
          </span>
        ) : null}
      </td>
      <td className="px-2 py-2.5 text-right tabular-nums">
        {d.requested_cents ? formatMoneyCompact(d.requested_cents) : "—"}
      </td>
      <td className="px-2 py-2.5 text-right tabular-nums">
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
      <td className="px-2 py-2.5 text-right tabular-nums">
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
      <td className="px-4 py-2.5 text-right text-xs text-muted whitespace-nowrap">
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{manager ? "Deals" : "My Deals"}</h1>
          <p className="text-sm text-muted">
            Every file you ever submitted — kickbacks, approvals, declines and fundings included.
          </p>
        </div>
        <Link href="/lead-intake" className="text-sm font-semibold text-accent hover:underline">
          + New lead
        </Link>
      </div>
      <nav aria-label="Filter" className="flex flex-wrap gap-1.5">
        {CHIPS.map((c) => {
          const n = countFor(c.key);
          return (
            <Link
              key={c.key}
              href={c.key === "live" ? "/deals" : `/deals?f=${c.key}`}
              aria-current={c.key === filter ? "page" : undefined}
              className={cn(
                "rounded-full border px-3 py-1 text-sm transition",
                c.key === filter
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-muted hover:text-text",
              )}
            >
              {c.label}
              {n ? <span className="ml-1 tabular-nums opacity-70">{n}</span> : null}
            </Link>
          );
        })}
      </nav>
      {deals.length === 0 ? (
        <EmptyState title="No deals here">
          {filter === "live"
            ? "Submit a lead to ops from the merchant page and it shows up here."
            : "Nothing matches this filter."}
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Merchant</th>
                <th className="px-2 py-2 font-medium">Where it is</th>
                <th className="px-2 py-2 text-right font-medium">Asked</th>
                <th className="px-2 py-2 text-right font-medium">Lenders</th>
                <th className="px-2 py-2 text-right font-medium">Best / funded</th>
                <th className="px-4 py-2 text-right font-medium">Last touch</th>
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
