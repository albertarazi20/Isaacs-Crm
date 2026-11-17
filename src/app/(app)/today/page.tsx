import { CountUp } from "@/components/fx";
import { TodayLists } from "@/components/power/TodayLists";
import { Glyph } from "@/components/shell/icons";
import { NewLeadButton } from "@/components/shell/NewLead";
import { StreakBadge } from "@/components/StreakBadge";
import { cn, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { snoozeCounts } from "@/lib/data/overdue";
import { listCards, userContext } from "@/lib/data/queries";
import { loadStreak } from "@/lib/data/streak";
import { buildToday } from "@/lib/data/views";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { parseISODate } from "@/lib/mca/dates";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** One figure in the summary strip: a label, the number, a line of what it means. */
function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint: string;
  tone?: "warn" | "accent";
}) {
  return (
    <div className="min-w-0 px-4 py-3 sm:px-5 sm:py-4">
      <p className="eyebrow">{label}</p>
      <p
        className={cn(
          "mt-1.5 text-[26px] leading-none font-semibold tracking-[-0.03em] tabular-nums",
          value > 0 && tone === "warn" && "text-warn",
          value > 0 && tone === "accent" && "text-accent",
        )}
      >
        {value}
      </p>
      <p className="mt-1.5 truncate text-xs text-muted">{hint}</p>
    </div>
  );
}

export default async function TodayPage() {
  const session = await requireSession();
  const { cards, ctx, view, snoozed, streak } = await db.withUser(session.userId, async (q) => {
    const cards = await listCards(q);
    const ctx = await userContext(q);
    const view = buildToday(cards, ctx.today, ctx.timezone);
    // One query for every visible row: how often each had its date pushed in the last 14 days.
    const visible = [...view.scheduled, ...view.overdue, ...view.dueToday, ...view.upcoming];
    const ids = visible.map((c) => c.id);
    return {
      cards,
      ctx,
      view,
      snoozed: await snoozeCounts(q, ids),
      streak: await loadStreak(q, ctx.today, ctx.timezone),
    };
  });
  const dialable = view.scheduled.length + view.overdue.length + view.dueToday.length;
  const { kpis } = view;
  const allClear = dialable === 0;
  const nextUp = cards
    .map((c) => c.next_due_on)
    .filter((d): d is string => d !== null && d > ctx.today)
    .sort()[0];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`${WEEKDAYS[parseISODate(ctx.today).getUTCDay()]}, ${formatDate(ctx.today)}`}
        title="Call list"
        description={
          allClear
            ? "Nothing is waiting on you right now."
            : `${kpis.dueToday} due today and ${kpis.overdue} overdue. Start at the top, or let power dial feed you one at a time.`
        }
        actions={
          dialable > 0 ? (
            <LinkButton href="/dial" variant="primary">
              <Glyph name="zap" className="size-4" />
              Start power dial
              <span className="rounded-full bg-white/20 px-1.5 text-[11px] tabular-nums">
                {dialable}
              </span>
            </LinkButton>
          ) : null
        }
      />

      <section
        aria-label="Today in numbers"
        className="ring-brand grid rounded-2xl border border-border bg-surface md:grid-cols-[minmax(0,1.25fr)_minmax(0,2fr)]"
      >
        <div className="flex flex-col justify-center gap-3 px-4 py-4 sm:px-5 sm:py-5">
          <div className="flex items-end gap-3">
            <p className="text-gradient text-[52px] leading-[0.9] font-semibold tracking-[-0.045em]">
              <CountUp value={dialable} />
            </p>
            <p className="pb-1 text-sm leading-tight text-text-2">
              to call
              <span className="block text-xs text-muted">overdue, due today and booked</span>
            </p>
          </div>
          <StreakBadge streak={streak} />
        </div>
        <div className="grid grid-cols-3 divide-x divide-border border-border max-md:border-t md:border-l">
          <Figure label="Overdue" value={kpis.overdue} hint="Past their date" tone="warn" />
          <Figure label="Due today" value={kpis.dueToday} hint="On schedule" tone="accent" />
          <Figure label="Next 7 days" value={kpis.next7} hint="Coming up" />
        </div>
      </section>

      {cards.length === 0 ? (
        <EmptyState title="No merchants yet" action={<NewLeadButton />}>
          Add a lead. A name and a number is enough to start the clock.
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
