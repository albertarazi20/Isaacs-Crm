import { ClientRow } from "@/components/ClientRow";
import { PageHeader } from "@/components/settings/primitives";
import { Badge, EmptyState, LinkButton, SectionTitle } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { listCards, userContext } from "@/lib/data/queries";
import { groupLongGame } from "@/lib/data/views";
import { db } from "@/lib/db";

export default async function LongGamePage() {
  const session = await requireSession();
  const { cards, ctx } = await db.withUser(session.userId, async (q) => ({
    cards: await listCards(q),
    ctx: await userContext(q),
  }));
  const groups = groupLongGame(cards, ctx.today);
  const total = groups.reduce((n, g) => n + g.cards.length, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Long game"
        context={
          <>
            {total} client{total === 1 ? "" : "s"} parked more than a year out. They aren&apos;t
            gone — each one comes back on its date.
          </>
        }
        actions={<LinkButton href="/winback">Win-back: who&apos;s due now →</LinkButton>}
      />
      {groups.length === 0 ? (
        <EmptyState title="Nothing parked beyond a year">
          Set a follow-up 18, 24 or 36 months out for a merchant who funded elsewhere, and
          they&apos;ll wait here.
        </EmptyState>
      ) : (
        groups.map((g) => (
          <section key={g.key} className="space-y-3">
            <SectionTitle
              aside={
                <Badge tone="neutral" className="tabular-nums">
                  {g.cards.length}
                </Badge>
              }
            >
              {g.label}
            </SectionTitle>
            <div className="grid min-w-0 gap-3 xl:grid-cols-2">
              {g.cards.map((c) => (
                <ClientRow key={c.id} card={c} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
