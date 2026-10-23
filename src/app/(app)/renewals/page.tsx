import Link from "next/link";
import { ClientRow } from "@/components/ClientRow";
import { cn, EmptyState, SectionTitle } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { listCards, userContext } from "@/lib/data/queries";
import { buildRenewals } from "@/lib/data/views";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";

const THRESHOLDS = [50, 60, 70, 80, 90];

export default async function RenewalsPage({
  searchParams,
}: {
  searchParams: Promise<{ min?: string }>;
}) {
  const { min } = await searchParams;
  const minPct = THRESHOLDS.includes(Number(min)) ? Number(min) : 50;
  const session = await requireSession();
  const { cards, ctx } = await db.withUser(session.userId, async (q) => ({
    cards: await listCards(q),
    ctx: await userContext(q),
  }));
  const { ready, paidOff } = buildRenewals(cards, ctx.today, minPct);
  const stillOwed = ready.reduce((s, r) => s + r.balanceCents, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Renewals</h1>
          <p className="text-sm text-muted">
            Merchants paid down enough to offer a renewal. Your best leads.
          </p>
        </div>
        <nav aria-label="Paid down at least" className="flex items-center gap-1.5">
          <span className="text-sm text-muted">Paid down at least</span>
          {THRESHOLDS.map((p) => (
            <Link
              key={p}
              href={`/renewals?min=${p}`}
              aria-current={p === minPct ? "page" : undefined}
              className={cn(
                "rounded-lg border px-2.5 py-1 text-sm font-medium",
                p === minPct
                  ? "border-accent bg-accent text-accent-fg"
                  : "border-border bg-surface hover:bg-surface-2",
              )}
            >
              {p}%
            </Link>
          ))}
        </nav>
      </div>

      <section className="space-y-2">
        <SectionTitle
          aside={
            <span className="text-sm text-muted">{formatMoney(stillOwed)} payback outstanding</span>
          }
        >
          Ready to renew ({ready.length})
        </SectionTitle>
        {ready.length === 0 ? (
          <EmptyState title={`Nobody is ${minPct}% paid down yet`}>
            Funded merchants show up here the day they cross the line.
          </EmptyState>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {ready.map((r) => (
              <ClientRow key={r.card.id} card={r.card} showPaydown />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <SectionTitle>Paid in full ({paidOff.length})</SectionTitle>
        {paidOff.length === 0 ? (
          <EmptyState title="Nobody has paid off yet" />
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {paidOff.map((c) => (
              <ClientRow key={c.id} card={c} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
