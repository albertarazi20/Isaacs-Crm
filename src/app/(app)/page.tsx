import { TodayLists } from "@/components/power/TodayLists";
import { EmptyState, LinkButton } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { snoozeCounts } from "@/lib/data/overdue";
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
  const { cards, ctx, view, snoozed } = await db.withUser(session.userId, async (q) => {
    const cards = await listCards(q);
    const ctx = await userContext(q);
    const view = buildToday(cards, ctx.today);
    // One query for every visible row: how often each had its date pushed in the last 14 days.
    const visible = [...view.scheduled, ...view.overdue, ...view.dueToday, ...view.upcoming];
    const ids = visible.map((c) => c.id);
    return { cards, ctx, view, snoozed: await snoozeCounts(q, ids) };
  });
  const dialable = view.scheduled.length + view.overdue.length + view.dueToday.length;
  const { kpis } = view;
  const allClear = view.overdue.length + view.dueToday.length + view.scheduled.length === 0;
  const nextUp = cards
    .map((c) => c.next_due_on)
    .filter((d): d is string => d !== null && d > ctx.today)
    .sort()[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Today</h1>
          <p className="text-sm text-muted">
            {WEEKDAYS[parseISODate(ctx.today).getUTCDay()]}, {formatDate(ctx.today)}
          </p>
        </div>
        {dialable > 0 ? (
          <LinkButton href="/dial" variant="primary">
            Start dialing ({dialable})
          </LinkButton>
        ) : null}
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

      <TodayLists
        scheduled={view.scheduled}
        overdue={view.overdue}
        dueToday={view.dueToday}
        upcoming={view.upcoming}
        snoozeCounts={snoozed}
      />
    </div>
  );
}
