import Link from "next/link";
import { GoalEditor } from "@/components/dashboard/GoalEditor";
import { Card, EmptyState, LinkButton, SectionTitle, cn } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import {
  biggestLeak,
  funnel,
  pace,
  type NowItem,
  type NowKind,
  type Pace,
} from "@/lib/dashboard/metrics";
import {
  emailMeters,
  funnelCounts,
  lenderScorecard,
  listGoals,
  moneyOnTable,
  monthOf,
  monthScoreboard,
  nowItems,
  repScorecard,
  type EmailMeter,
  type LenderScore,
  type MoneyOnTable,
  type RepScore,
  type Scoreboard,
} from "@/lib/dashboard/queries";
import { dueCount, userContext } from "@/lib/data/queries";
import { dealStatusCounts } from "@/lib/deals/queries";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { formatMoneyCompact } from "@/lib/money";
import { parseISODate } from "@/lib/mca/dates";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const KIND_LABEL: Record<NowKind, string> = {
  merchant_replied: "Reply",
  decision: "Decide",
  kicked_back: "Kicked back",
  offer_unpresented: "Offer in",
  approval_aging: "Close",
  renewal_ready: "Renewal",
  overdue: "Overdue",
  stale_submission: "Chase",
};
const KIND_TONE: Record<NowKind, string> = {
  merchant_replied: "bg-bad-soft text-bad",
  decision: "bg-accent-soft text-accent",
  kicked_back: "bg-bad-soft text-bad",
  offer_unpresented: "bg-good-soft text-good",
  approval_aging: "bg-warn-soft text-warn",
  renewal_ready: "bg-good-soft text-good",
  overdue: "bg-warn-soft text-warn",
  stale_submission: "bg-surface-2 text-muted",
};

function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "good" | "warn" | "bad";
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
    <div className="rounded-xl border border-border bg-surface px-4 py-3.5">
      <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">{label}</p>
      <p className={cn("mt-1 text-[26px] leading-8 font-bold tracking-tight tabular-nums", color)}>
        {value}
      </p>
      {sub ? <p className="mt-0.5 truncate text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

function PaceBar({
  p,
  label,
  month,
  userId,
  canEdit,
}: {
  p: Pace;
  label: string;
  month: string;
  userId: string | null;
  canEdit: boolean;
}) {
  const tone =
    p.status === "behind"
      ? "bg-bad"
      : p.status === "ahead" || p.status === "done"
        ? "bg-good"
        : "bg-accent";
  const expectedPct =
    p.goalCents > 0 ? Math.min(100, Math.round((100 * p.expectedByNowCents) / p.goalCents)) : 0;
  const words =
    p.status === "no_goal"
      ? "No goal set for this month."
      : p.status === "done"
        ? "Goal hit."
        : p.status === "behind"
          ? `${formatMoneyCompact(-p.deltaCents)} behind pace · ${formatMoneyCompact(p.neededPerDayCents)} a day for the next ${p.weekdaysLeft} weekdays`
          : p.status === "ahead"
            ? `${formatMoneyCompact(p.deltaCents)} ahead of pace`
            : `On pace · ${formatMoneyCompact(p.neededPerDayCents)} a day to finish`;
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold">{label}</p>
        <p className="text-sm tabular-nums">
          <span className="font-bold">{formatMoneyCompact(p.fundedCents)}</span>
          {p.goalCents > 0 ? (
            <span className="text-muted"> of {formatMoneyCompact(p.goalCents)}</span>
          ) : null}
        </p>
      </div>
      <div className="relative mt-2 h-2.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn("h-full rounded-full transition-all", tone)}
          style={{ width: `${p.pct}%` }}
        />
        {p.goalCents > 0 ? (
          <div
            className="absolute top-0 h-full w-px bg-text/60"
            style={{ left: `${expectedPct}%` }}
            title="Where a straight line to the goal says you should be today"
          />
        ) : null}
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted">
        <span>{words}</span>
        {canEdit ? (
          <GoalEditor
            month={month}
            userId={userId}
            fundedCents={p.goalCents}
            label={label.toLowerCase()}
          />
        ) : null}
      </div>
    </div>
  );
}

function NowList({
  items,
  total,
  owners,
}: {
  items: NowItem[];
  total: number;
  owners?: Record<string, string>;
}) {
  if (items.length === 0)
    return (
      <EmptyState title="Nothing is waiting on you">
        New replies, kickbacks, offers and overdue calls land here, ranked by what loses money
        fastest.
      </EmptyState>
    );
  return (
    <Card className="p-0">
      <ol className="divide-y divide-border">
        {items.map((n, i) => (
          <li key={`${n.kind}-${n.client_id}-${n.deal_id ?? ""}-${i}`}>
            <Link
              href={n.href}
              className="flex items-start gap-3 px-4 py-3 transition hover:bg-surface-2"
            >
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold",
                  KIND_TONE[n.kind],
                )}
              >
                {KIND_LABEL[n.kind]}
              </span>
              <span className="min-w-0 flex-1">
                {owners?.[n.client_id] ? (
                  <span className="float-right ml-2 text-xs text-muted">{owners[n.client_id]}</span>
                ) : null}
                <span className="block truncate text-sm font-semibold">
                  {n.label} <span className="font-normal text-muted">· {n.business_name}</span>
                </span>
                {n.detail ? (
                  <span className="block truncate text-xs text-muted">{n.detail}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-right text-xs text-muted tabular-nums">
                {n.cents > 0 ? (
                  <span className="block font-semibold text-text">
                    {formatMoneyCompact(n.cents)}
                  </span>
                ) : null}
                {n.age_days > 0 ? `${n.age_days}d` : "today"}
              </span>
            </Link>
          </li>
        ))}
      </ol>
      {total > items.length ? (
        <p className="border-t border-border px-4 py-2 text-xs text-muted">
          {total - items.length} more below the fold — work the top of the list first.
        </p>
      ) : null}
    </Card>
  );
}

function FunnelBlock({ counts, month }: { counts: Parameters<typeof funnel>[0]; month: string }) {
  const steps = funnel(counts);
  const leak = biggestLeak(steps);
  const max = Math.max(1, ...steps.map((s) => s.count));
  return (
    <Card>
      <SectionTitle aside={<span className="text-xs text-muted">{month}</span>}>
        Funnel
      </SectionTitle>
      <ol className="mt-3 space-y-2">
        {steps.map((s) => (
          <li key={s.key} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 text-sm">
            <span className="text-muted">{s.label}</span>
            <span className="h-5 overflow-hidden rounded bg-surface-2">
              <span
                className="block h-full rounded bg-accent/80"
                style={{ width: `${Math.max(2, Math.round((100 * s.count) / max))}%` }}
              />
            </span>
            <span className="w-28 text-right tabular-nums">
              <span className="font-semibold">{s.count}</span>
              {s.fromPrevPct !== null ? (
                <span className="text-muted"> · {s.fromPrevPct}%</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {leak ? (
        <p className="mt-3 text-xs text-muted">
          Biggest leak: <span className="font-semibold text-text">{leak.lost}</span> lost between{" "}
          {leak.from.label.toLowerCase()} and {leak.to.label.toLowerCase()}.
        </p>
      ) : null}
    </Card>
  );
}

function MoneyBlock({ m }: { m: MoneyOnTable }) {
  return (
    <Card>
      <SectionTitle
        aside={
          <span className="text-sm font-bold tabular-nums">
            {formatMoneyCompact(m.approved_unfunded_cents + m.renewals_ready_cents)}
          </span>
        }
      >
        Money on the table
      </SectionTitle>
      <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs text-muted">Approved, not funded</dt>
          <dd className="font-semibold tabular-nums">
            {formatMoneyCompact(m.approved_unfunded_cents)}
          </dd>
          <dd className="text-xs text-muted">{m.approved_unfunded.length} offers</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Renewals ready</dt>
          <dd className="font-semibold tabular-nums">
            {formatMoneyCompact(m.renewals_ready_cents)}
          </dd>
          <dd className="text-xs text-muted">{m.renewals_ready.length} advances</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Commission owed to us</dt>
          <dd className="font-semibold tabular-nums">
            {formatMoneyCompact(m.expected_commission_cents)}
          </dd>
          <dd className="text-xs text-muted">confirmed, not yet paid</dd>
        </div>
      </dl>
      {m.approved_unfunded.length > 0 ? (
        <ul className="mt-3 divide-y divide-border border-t border-border text-sm">
          {m.approved_unfunded.slice(0, 6).map((a) => (
            <li key={a.client_id} className="flex items-center justify-between gap-3 py-2">
              <Link
                href={a.deal_id ? `/deals/${a.deal_id}` : `/clients/${a.client_id}`}
                className="min-w-0 truncate font-medium hover:underline"
              >
                {a.business_name}
              </Link>
              <span className="shrink-0 text-xs text-muted">
                {a.funder_name} · {formatMoneyCompact(a.amount_cents)} at {a.factor_rate} · {a.days}
                d
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function RepTable({ rows, month }: { rows: RepScore[]; month: string }) {
  return (
    <Card className="min-w-0 overflow-x-auto p-0">
      <div className="px-4 pt-4">
        <SectionTitle aside={<span className="text-xs text-muted">{month}</span>}>
          Team
        </SectionTitle>
      </div>
      <table className="mt-2 w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="px-4 py-2 font-medium">Rep</th>
            <th className="px-2 py-2 text-right font-medium">Leads</th>
            <th className="px-2 py-2 text-right font-medium">Submitted</th>
            <th className="px-2 py-2 text-right font-medium">Approved</th>
            <th className="px-2 py-2 text-right font-medium">Funded</th>
            <th className="px-2 py-2 text-right font-medium">Volume</th>
            <th className="px-2 py-2 text-right font-medium">Commission</th>
            <th className="px-2 py-2 text-right font-medium">Overdue</th>
            <th className="px-4 py-2 text-right font-medium">Speed to lead</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.user_id}>
              <td className="px-4 py-2 font-medium">
                {r.name || r.email}
                {r.role !== "rep" ? (
                  <span className="ml-1 text-xs text-muted">{r.role}</span>
                ) : null}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{r.new_leads}</td>
              <td className="px-2 py-2 text-right tabular-nums">{r.submitted}</td>
              <td className="px-2 py-2 text-right tabular-nums">{r.approved}</td>
              <td className="px-2 py-2 text-right tabular-nums">{r.funded_count}</td>
              <td className="px-2 py-2 text-right tabular-nums">
                {formatMoneyCompact(Number(r.funded_cents))}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {formatMoneyCompact(Number(r.commission_cents))}
              </td>
              <td className={cn("px-2 py-2 text-right tabular-nums", r.overdue > 0 && "text-bad")}>
                {r.overdue}
              </td>
              <td className="px-4 py-2 text-right tabular-nums">
                {r.speed_to_lead_hours === null ? "—" : `${r.speed_to_lead_hours}h`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function LenderTable({ rows }: { rows: LenderScore[] }) {
  return (
    <Card className="min-w-0 overflow-x-auto p-0">
      <div className="px-4 pt-4">
        <SectionTitle
          aside={
            <Link href="/funders" className="text-xs text-accent hover:underline">
              All lenders
            </Link>
          }
        >
          Lenders
        </SectionTitle>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 pt-2 text-sm text-muted">Nothing sent yet.</p>
      ) : (
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Lender</th>
              <th className="px-2 py-2 text-right font-medium">Sent</th>
              <th className="px-2 py-2 text-right font-medium">Approved</th>
              <th className="px-2 py-2 text-right font-medium">Rate</th>
              <th className="px-2 py-2 text-right font-medium">Avg factor</th>
              <th className="px-4 py-2 text-right font-medium">Answers in</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.slice(0, 8).map((r) => (
              <tr key={r.funderId}>
                <td className="px-4 py-2 font-medium">{r.name}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.submissions}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.approvals}</td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {r.approvalRate === null ? "—" : `${Math.round(r.approvalRate * 100)}%`}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {r.avgFactor === null ? "—" : r.avgFactor.toFixed(2)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {r.avgDaysToRespond === null ? "—" : `${r.avgDaysToRespond}d`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Meters({ meters }: { meters: EmailMeter[] }) {
  if (meters.length === 0) return null;
  return (
    <Card>
      <SectionTitle
        aside={
          <Link href="/settings/email" className="text-xs text-accent hover:underline">
            Email settings
          </Link>
        }
      >
        Email meter · last 24h
      </SectionTitle>
      <ul className="mt-3 space-y-2">
        {meters.map((m) => {
          const pct = Math.min(100, Math.round((100 * m.sent_24h) / Math.max(1, m.cap)));
          const tone = m.tone === "red" ? "bg-bad" : m.tone === "amber" ? "bg-warn" : "bg-good";
          return (
            <li key={m.mailbox_id} className="text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate">
                  {m.owner_name ?? "Shop automation"}{" "}
                  <span className="text-muted">· {m.address}</span>
                </span>
                <span className="tabular-nums text-muted">
                  {m.sent_24h} / {m.cap}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className={cn("h-full rounded-full", tone)} style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const { denied } = await searchParams;
  const session = await requireSession();
  const manager = CAN.seeEveryone(session.role);
  const ops = session.role === "ops";
  const data = await db.withUser(session.userId, async (q) => {
    const ctx = await userContext(q);
    const month = monthOf(ctx.today);
    // one connection, one query at a time (pg serialises anyway and warns about overlap)
    const score = await monthScoreboard(q, month);
    const money = await moneyOnTable(q, ctx.today);
    const counts = await funnelCounts(q, month);
    const now = await nowItems(q, ctx.today, { manager });
    // the queue tiles for ops (their Dashboard is the board's front door, not a commission sheet)
    const queue = ops ? await dealStatusCounts(q) : null;
    // whose merchant each line is, for anyone who sees more than their own book (P2-2)
    const owners: Record<string, string> =
      (manager || ops) && now.length > 0
        ? Object.fromEntries(
            (
              await q.query<{ id: string; name: string }>(
                `select c.id, coalesce(nullif(u.name, ''), u.email) as name
                   from clients c join app_users u on u.id = c.user_id where c.id = any($1::uuid[])`,
                [Array.from(new Set(now.map((n) => n.client_id)))],
              )
            ).rows.map((r) => [r.id, r.name]),
          )
        : {};
    const goals = await listGoals(q, month);
    const due = await dueCount(q, ctx.today);
    const extra = manager
      ? ([
          await repScorecard(q, month, ctx.today),
          await lenderScorecard(q),
          await emailMeters(q),
          (
            await q.query<{ n: number }>(
              "select count(*)::int as n from proposed_updates where status = 'proposed'",
            )
          ).rows[0]?.n ?? 0,
        ] as const)
      : null;
    return { ctx, month, score, money, counts, now, goals, due, extra, queue, owners };
  });
  const { ctx, month, score, money, counts, now, goals, due, extra, queue, owners } = data;
  const monthName = `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
  const shopGoal = goals.find((g) => g.user_id === null)?.funded_cents ?? 0;
  const myGoal = goals.find((g) => g.user_id === session.userId)?.funded_cents ?? 0;
  const myFunded = extra
    ? Number(extra[0].find((r) => r.user_id === session.userId)?.funded_cents ?? 0)
    : score.funded_cents;
  const scoreboard: Scoreboard = score;

  return (
    <div className="space-y-6">
      {denied ? (
        <p
          role="status"
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted"
        >
          That page isn&apos;t part of your role, so you&apos;re back on the Dashboard.
        </p>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted">
            {WEEKDAYS[parseISODate(ctx.today).getUTCDay()]}, {formatDate(ctx.today)} · {monthName}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {due > 0 ? (
            <LinkButton href="/today" variant="primary">
              {due} follow-up{due === 1 ? "" : "s"} due
            </LinkButton>
          ) : null}
          {extra && extra[3] > 0 ? (
            <LinkButton href="/board?tab=review">Review tray ({extra[3]})</LinkButton>
          ) : null}
        </div>
      </div>

      {ops && queue ? (
        <OpsQueue queue={queue} />
      ) : (
        <>
          <div className={cn("grid gap-3", manager ? "md:grid-cols-2" : "")}>
            {manager ? (
              <PaceBar
                p={pace(scoreboard.funded_cents, shopGoal, ctx.today)}
                label="Shop"
                month={month}
                userId={null}
                canEdit
              />
            ) : null}
            <PaceBar
              p={pace(myFunded, myGoal, ctx.today)}
              label={manager ? "My own book" : "My month"}
              month={month}
              userId={session.userId}
              canEdit={manager}
            />
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi
              label="Funded"
              value={formatMoneyCompact(scoreboard.funded_cents)}
              sub={`${scoreboard.funded_count} deal${scoreboard.funded_count === 1 ? "" : "s"}`}
              tone={scoreboard.funded_count > 0 ? "good" : undefined}
            />
            <Kpi
              label={manager ? "Commission" : "My cut"}
              value={formatMoneyCompact(
                manager ? scoreboard.commission_cents : scoreboard.rep_cut_cents,
              )}
              sub={scoreboard.avg_points !== null ? `${scoreboard.avg_points} pts avg` : undefined}
            />
            <Kpi label="Submitted" value={scoreboard.submitted} />
            <Kpi
              label="Approved"
              value={scoreboard.approved}
              sub={`${scoreboard.offers_in} offers in`}
            />
            <Kpi
              label="New leads"
              value={scoreboard.new_leads}
              sub={`${scoreboard.apps_in} applications in`}
            />
            <Kpi
              label="Avg deal"
              value={
                scoreboard.avg_deal_cents === null
                  ? "—"
                  : formatMoneyCompact(scoreboard.avg_deal_cents)
              }
            />
          </div>
        </>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="space-y-3">
          <SectionTitle
            aside={
              <span className="text-xs text-muted">
                {now.length} item{now.length === 1 ? "" : "s"}
              </span>
            }
          >
            Do this now
          </SectionTitle>
          <NowList items={now.slice(0, 12)} total={now.length} owners={owners} />
        </section>
        <aside className="space-y-6">
          <MoneyBlock m={money} />
          <FunnelBlock counts={counts} month={monthName} />
        </aside>
      </div>

      {extra ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <RepTable rows={extra[0]} month={monthName} />
          <div className="space-y-6">
            <LenderTable rows={extra[1]} />
            <Meters meters={extra[2]} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Ops see what is waiting on them, by lane, instead of a rep's money tiles (P2-4). */
function OpsQueue({ queue }: { queue: Record<string, number> }) {
  const tiles: { key: string; label: string; lane: string | null; tone?: "warn" | "good" }[] = [
    { key: "working_ops", label: "Waiting on you", lane: null, tone: "warn" },
    { key: "kicked_back", label: "Back with the rep", lane: "kicked_back" },
    { key: "pending_lenders", label: "With lenders", lane: "pending_lenders" },
    { key: "stips_needed", label: "A lender asked for more", lane: "stips_needed" },
    { key: "needs_pitch", label: "Approved, not presented", lane: "needs_pitch", tone: "good" },
    { key: "contracts_out", label: "Contracts out", lane: "contracts_out" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t) => (
        <Link key={t.key} href={t.lane ? `/board?lane=${t.lane}` : "/board"} className="block">
          <Kpi
            label={t.label}
            value={queue[t.key] ?? 0}
            tone={(queue[t.key] ?? 0) > 0 ? t.tone : undefined}
          />
        </Link>
      ))}
    </div>
  );
}
