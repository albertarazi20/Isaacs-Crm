import { ClientRow } from "@/components/ClientRow";
import { EmptyState, SectionTitle } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { listCards, userContext } from "@/lib/data/queries";
import { buildToday } from "@/lib/data/views";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { formatMoneyCompact } from "@/lib/money";
import { parseISODate } from "@/lib/mca/dates";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "bad" | "warn" | "good";
}) {
  const color =
    tone === "bad"
      ? "text-bad"
      : tone === "warn"
        ? "text-warn"
        : tone === "good"
          ? "text-good"
          : "text-text";
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={`mt-0.5 text-2xl font-bold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

export default async function TodayPage() {
  const session = await requireSession();
  const { cards, ctx } = await db.withUser(session.userId, async (q) => ({
    cards: await listCards(q),
    ctx: await userContext(q),
  }));
  const view = buildToday(cards, ctx.today);
  const { kpis } = view;
  const allClear = view.overdue.length + view.dueToday.length + view.scheduled.length === 0;
  const nextUp = cards
    .map((c) => c.next_due_on)
    .filter((d): d is string => d !== null && d > ctx.today)
    .sort()[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Today</h1>
        <p className="text-sm text-muted">
          {WEEKDAYS[parseISODate(ctx.today).getUTCDay()]}, {formatDate(ctx.today)}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Overdue" value={kpis.overdue} tone={kpis.overdue > 0 ? "bad" : undefined} />
        <Kpi
          label="Due today"
          value={kpis.dueToday}
          tone={kpis.dueToday > 0 ? "warn" : undefined}
        />
        <Kpi label="Next 7 days" value={kpis.next7} />
        <Kpi
          label="Ready to renew (50%+)"
          value={kpis.renewalReady}
          tone={kpis.renewalReady > 0 ? "good" : undefined}
        />
        <Kpi label="Active advances" value={kpis.fundedActive} />
        <Kpi label="Payback outstanding" value={formatMoneyCompact(kpis.outstandingCents)} />
      </div>

      {cards.length === 0 ? (
        <EmptyState title="No clients yet">
          Press “+ Add client” — a name and a number is enough to start the clock.
        </EmptyState>
      ) : allClear ? (
        <EmptyState title="You're all caught up">
          {nextUp ? `Next follow-up is ${formatDate(nextUp, ctx.today)}.` : "Nothing is scheduled."}
        </EmptyState>
      ) : null}

      {view.scheduled.length > 0 ? (
        <section className="space-y-2">
          <SectionTitle>Calls booked today ({view.scheduled.length})</SectionTitle>
          <div className="grid gap-3 xl:grid-cols-2">
            {view.scheduled.map((c) => (
              <ClientRow key={c.id} card={c} />
            ))}
          </div>
        </section>
      ) : null}

      {view.overdue.length > 0 ? (
        <section className="space-y-2">
          <SectionTitle>
            <span className="text-bad">Overdue ({view.overdue.length})</span>
          </SectionTitle>
          <div className="grid gap-3 xl:grid-cols-2">
            {view.overdue.map((c) => (
              <ClientRow key={c.id} card={c} />
            ))}
          </div>
        </section>
      ) : null}

      {view.dueToday.length > 0 ? (
        <section className="space-y-2">
          <SectionTitle>Due today ({view.dueToday.length})</SectionTitle>
          <div className="grid gap-3 xl:grid-cols-2">
            {view.dueToday.map((c) => (
              <ClientRow key={c.id} card={c} />
            ))}
          </div>
        </section>
      ) : null}

      {view.upcoming.length > 0 ? (
        <details className="group space-y-2">
          <summary className="cursor-pointer text-sm font-semibold tracking-wide text-muted uppercase">
            Coming up in the next 7 days ({view.upcoming.length})
          </summary>
          <div className="mt-2 grid gap-3 xl:grid-cols-2">
            {view.upcoming.map((c) => (
              <ClientRow key={c.id} card={c} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
