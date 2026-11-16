import { PoolRow, type PoolMember } from "@/components/winback/PoolRow";
import { PageHeader, StatTile } from "@/components/settings/primitives";
import { Badge, Card, EmptyState, LinkButton, SectionTitle } from "@/components/ui";
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
      <PageHeader
        title="Winback"
        context={
          <>
            Approved-and-unfunded after 30 days, curable declines, paid-offs and the ones who went
            elsewhere. The pools email on their own cadence; a reply stops the emails and puts them
            at the top.
          </>
        }
        actions={<LinkButton href="/settings/buckets?tab=winback">Pool emails →</LinkButton>}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="In the pools" value={rows.length} />
        <StatTile
          label="Replied, waiting"
          value={replied.length}
          tone={replied.length ? "bad" : undefined}
        />
        <StatTile
          label="Active sequences"
          value={rows.filter((r) => r.status === "active").length}
        />
        <StatTile label="Was on the table" value={formatMoneyCompact(onTable)} />
      </div>
      {rows.length === 0 ? (
        <EmptyState title="Nobody to win back yet">
          Approvals that sit 30 days, curable declines and paid-offs land here on their own.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {[...pools.entries()].map(([key, p]) => (
            <Card key={key} className="min-w-0 p-0">
              <div className="px-4 pt-3.5 pb-3">
                <SectionTitle
                  aside={
                    <Badge tone="neutral" className="tabular-nums">
                      {p.members.length}
                    </Badge>
                  }
                >
                  {p.name}
                </SectionTitle>
                {POOL_HINT[key] ? (
                  <p className="mt-1 max-w-3xl text-xs text-muted">{POOL_HINT[key]}</p>
                ) : null}
              </div>
              <ul className="divide-y divide-border border-t border-border">
                {p.members.map((m) => (
                  <PoolRow key={m.id} m={m} today={today} />
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
