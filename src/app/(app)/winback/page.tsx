import Link from "next/link";
import { PoolRow, type PoolMember } from "@/components/winback/PoolRow";
import { Card, EmptyState, SectionTitle } from "@/components/ui";
import { requirePage } from "@/lib/auth/server";
import { userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { listWinback } from "@/lib/money/winback";
import { formatMoneyCompact } from "@/lib/money";

export const dynamic = "force-dynamic";

const POOL_HINT: Record<string, string> = {
  approved_unfunded:
    "Approved and never closed. Thirty days after the approval they get a daily-cadence email that steps down; the moment they reply, the sequence stops and they are yours to call.",
  declined_curable:
    "Declined for something that heals — NSFs, time in business, a position. The cure date sets the first email.",
  funded_elsewhere: "Took another lender's money. Their renewal window is the next shot.",
  paid_off: "Paid in full. The easiest money there is.",
  cold: "Went quiet before an application. Light touches, long gaps.",
};

export default async function WinbackPage() {
  const session = await requirePage("/winback");
  const { rows, today } = await db.withUser(session.userId, async (q) => ({
    today: (await userContext(q)).today,
    rows: await listWinback(q),
  }));
  const pools = new Map<string, { name: string; members: PoolMember[] }>();
  for (const r of rows) {
    const p = pools.get(r.pool) ?? { name: r.pool_name, members: [] };
    p.members.push(r);
    pools.set(r.pool, p);
  }
  const replied = rows.filter((r) => r.status === "replied");
  const onTable = rows.reduce((n, r) => n + (r.best_offer_cents ?? 0), 0);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Winback</h1>
          <p className="text-sm text-muted">
            Approved-and-unfunded after 30 days, curable declines, paid-offs and the ones who went
            elsewhere. The pools email on their own cadence; a reply stops the emails and puts them
            at the top.
          </p>
        </div>
        <Link
          href="/settings/buckets?tab=winback"
          className="text-sm font-semibold text-accent hover:underline"
        >
          Pool emails →
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">
            In the pools
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{rows.length}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">
            Replied, waiting
          </p>
          <p className={`mt-1 text-2xl font-bold tabular-nums ${replied.length ? "text-bad" : ""}`}>
            {replied.length}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">
            Active sequences
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">
            {rows.filter((r) => r.status === "active").length}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">
            Was on the table
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums">{formatMoneyCompact(onTable)}</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="Nobody to win back yet">
          Approvals that sit 30 days, curable declines and paid-offs land here on their own.
        </EmptyState>
      ) : (
        [...pools.entries()].map(([key, p]) => (
          <Card key={key} className="p-0">
            <div className="px-4 pt-4">
              <SectionTitle aside={<span className="text-xs text-muted">{p.members.length}</span>}>
                {p.name}
              </SectionTitle>
              {POOL_HINT[key] ? <p className="mt-1 text-xs text-muted">{POOL_HINT[key]}</p> : null}
            </div>
            <ul className="mt-2 divide-y divide-border">
              {p.members.map((m) => (
                <PoolRow key={m.id} m={m} today={today} />
              ))}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}
