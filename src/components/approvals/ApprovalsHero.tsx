import { cn } from "@/components/ui";
import type { ApprovalRow, ApprovalStats } from "@/lib/approvals/queries";
import { diffDays, type ISODate } from "@/lib/mca/dates";
import { offerMoney } from "@/lib/approvals/words";
import { formatMoneyCompact } from "@/lib/money";

/** The runway spans at least two weeks, out to the furthest hold (in whole weeks, at most nine). */
const runwayDays = (max: number) => Math.min(63, Math.max(14, Math.ceil((max + 1) / 7) * 7));

/**
 * The top of the funding desk: the money waiting on a pitch, who answered, whose hold runs out first, and the next two
 * weeks of holds laid out as a runway, so the order of the day can be read at a glance.
 */
export function ApprovalsHero({
  stats,
  open,
  today,
}: {
  stats: ApprovalStats;
  /** The open approvals, for the runway. */
  open: readonly ApprovalRow[];
  today: ISODate;
}) {
  const dated = open
    .filter((r) => r.hold_until)
    .map((r) => ({ r, days: diffDays(today, r.hold_until as ISODate) }))
    .sort((a, b) => a.days - b.days);
  const soonest = dated[0];
  return (
    <section
      aria-label="The desk today"
      className="relative overflow-hidden rounded-3xl border border-border bg-surface shadow-card"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -left-16 size-72 rounded-full bg-accent/15 blur-3xl"
      />
      <div className="relative grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.4fr)] lg:gap-8">
        {/* the money */}
        <div className="min-w-0">
          <p className="eyebrow">On the table</p>
          <p className="mt-2 text-gradient text-[44px] leading-none font-semibold tracking-[-0.045em] tabular-nums sm:text-[52px]">
            {formatMoneyCompact(stats.open_cents)}
          </p>
          <p className="mt-2 text-sm text-muted">
            {stats.open === 0
              ? "Nothing waiting on a pitch."
              : `${stats.open} ${stats.open === 1 ? "merchant" : "merchants"} approved and waiting on a pitch.`}
          </p>
          <dl className="mt-5 grid grid-cols-3 gap-2">
            <Metric
              label="Replied"
              value={String(stats.replied)}
              hint={stats.replied > 0 ? "call now" : "none waiting"}
              tone={stats.replied > 0 ? "accent" : "muted"}
              live={stats.replied > 0}
            />
            <Metric
              label="Ending"
              value={String(stats.expiring)}
              hint="hold in 3 days"
              tone={stats.expiring > 0 ? "warn" : "muted"}
            />
            <Metric
              label="Pitched"
              value={String(stats.pitched_7d)}
              hint={
                stats.pitched_7d > 0
                  ? `${formatMoneyCompact(stats.pitched_cents_7d)} this week`
                  : "this week"
              }
              tone={stats.pitched_7d > 0 ? "good" : "muted"}
            />
          </dl>
        </div>

        {/* the runway */}
        <div className="min-w-0 rounded-2xl border border-border bg-surface-3/50 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="eyebrow">When the holds end</p>
            <p className="truncate text-xs text-muted">
              {soonest
                ? soonest.days < 0
                  ? `${soonest.r.business_name}'s hold has ended`
                  : soonest.days === 0
                    ? `${soonest.r.business_name}'s hold ends today`
                    : `First to end: ${soonest.r.business_name}, in ${soonest.days} day${soonest.days === 1 ? "" : "s"}`
                : open.length > 0
                  ? "No hold dates set"
                  : "Nothing on hold"}
            </p>
          </div>
          <Runway items={dated} />
          {open.length > dated.length ? (
            <p className="mt-2 text-xs text-muted">
              {open.length - dated.length} without a hold date. Their emails say a week after they
              go out; add the funder&apos;s date to use that instead.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
  live,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "accent" | "warn" | "good" | "muted";
  live?: boolean;
}) {
  const ink = {
    accent: "text-accent",
    warn: "text-warn",
    good: "text-good",
    muted: "text-text",
  }[tone];
  return (
    <div className="min-w-0 rounded-2xl border border-border bg-surface-2/60 px-3 py-2.5">
      <dt className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
        {live ? <span className="live-dot text-accent" /> : null}
        <span className="truncate">{label}</span>
      </dt>
      <dd className={cn("mt-1 text-[22px] leading-none font-semibold tabular-nums", ink)}>
        {value}
      </dd>
      <dd className="mt-1 truncate text-[11.5px] text-muted">{hint}</dd>
    </div>
  );
}

/** Each open approval as a mark on the days ahead, placed on the day its hold ends; the first three days are shaded. */
function Runway({ items }: { items: readonly { r: ApprovalRow; days: number }[] }) {
  const span = runwayDays(Math.max(0, ...items.map((i) => i.days)));
  // marks on the same day stack upward
  const perDay = new Map<number, number>();
  const marks = items.map(({ r, days }) => {
    const at = Math.max(0, Math.min(span, days));
    const level = perDay.get(at) ?? 0;
    perDay.set(at, level + 1);
    return { r, days, at, level };
  });
  const tone = (days: number) =>
    days <= 0
      ? "bg-bad ring-bad/30"
      : days <= 3
        ? "bg-warn ring-warn/30"
        : "bg-accent ring-accent/30";
  return (
    <div className="mt-4">
      <div className="relative h-16">
        {/* the danger zone: the first three days */}
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 rounded-l-lg bg-linear-to-r from-warn/20 to-transparent"
          style={{ width: `${(3 / span) * 100}%` }}
        />
        <div aria-hidden className="absolute inset-x-0 bottom-3 h-px bg-border-strong" />
        {marks.map(({ r, days, at, level }) => (
          <span
            key={r.id}
            title={`${r.business_name}: ${offerMoney(r.amount_cents)}, ${days < 0 ? "hold ended" : days === 0 ? "hold ends today" : `${days} day${days === 1 ? "" : "s"} left`}`}
            className={cn(
              "absolute size-3.5 -translate-x-1/2 rounded-full ring-4 transition hover:scale-125",
              tone(days),
            )}
            style={{ left: `${(at / span) * 100}%`, bottom: `${6 + level * 16}px` }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[11px] text-muted tabular-nums">
        <span>Today</span>
        <span>{Math.round(span / 2)} days</span>
        <span>{span} days</span>
      </div>
      <ul className="sr-only">
        {marks.map(({ r, days }) => (
          <li key={r.id}>
            {r.business_name}: {days < 0 ? "hold ended" : `${days} days left`}
          </li>
        ))}
      </ul>
    </div>
  );
}
