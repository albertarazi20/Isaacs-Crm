import Link from "next/link";
import { Card, EmptyState, LinkButton, SectionTitle, cn } from "@/components/ui";
import { requireSession } from "@/lib/auth/server";
import { CAN } from "@/lib/auth/roles";
import type { NowItem, NowKind } from "@/lib/dashboard/metrics";
import {
  emailMeters,
  monthOf,
  monthScoreboard,
  nowItems,
  repScorecard,
  type EmailMeter,
  type RepScore,
} from "@/lib/dashboard/queries";
import { dueCount, userContext } from "@/lib/data/queries";
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
  overdue: "Overdue",
};
const KIND_TONE: Record<NowKind, string> = {
  merchant_replied: "bg-bad-soft text-bad",
  overdue: "bg-warn-soft text-warn",
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
      <p
        className={cn(
          "mt-1 text-[26px] leading-8 font-semibold tracking-tight tabular-nums",
          color,
        )}
      >
        {value}
      </p>
      {sub ? <p className="mt-0.5 truncate text-xs text-muted">{sub}</p> : null}
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
        New replies and overdue follow-ups land here, ranked by what is most likely to go cold.
      </EmptyState>
    );
  return (
    <Card className="p-0">
      <ol className="divide-y divide-border">
        {items.map((n, i) => (
          <li key={`${n.kind}-${n.client_id}-${i}`}>
            <Link
              href={n.href}
              className="flex items-start gap-3 px-4 py-2.5 transition hover:bg-surface-3"
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
                  {n.label}
                  {n.business_name && !n.label.includes(n.business_name) ? (
                    <span className="font-normal text-muted"> · {n.business_name}</span>
                  ) : null}
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

function RepTable({ rows, month, mine }: { rows: RepScore[]; month: string; mine: boolean }) {
  return (
    <Card className="min-w-0 overflow-x-auto p-0">
      <div className="px-4 pt-4">
        <SectionTitle aside={<span className="text-xs text-muted">{month}</span>}>
          {mine ? "My month" : "Team"}
        </SectionTitle>
      </div>
      <table className="mt-3 w-full text-[13px]">
        <thead className="bg-surface-2/60 text-left text-[11px] font-semibold tracking-wide text-muted uppercase">
          <tr>
            <th className="px-4 py-2 font-semibold">Rep</th>
            <th className="px-2 py-2 text-right font-semibold">Leads</th>
            <th className="px-2 py-2 text-right font-semibold">Overdue</th>
            <th className="px-4 py-2 text-right font-semibold">Speed to lead</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.user_id} className="transition hover:bg-surface-3">
              <td className="px-4 py-2 font-medium">
                {r.name || r.email}
                {r.role !== "rep" ? (
                  <span className="ml-1 text-xs text-muted">{r.role}</span>
                ) : null}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{r.new_leads}</td>
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

function Meters({ meters }: { meters: EmailMeter[] }) {
  if (meters.length === 0) return null;
  return (
    <Card className="p-4">
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
  const data = await db.withUser(session.userId, async (q) => {
    const ctx = await userContext(q);
    const month = monthOf(ctx.today);
    // one connection, one query at a time (pg serialises anyway and warns about overlap)
    const score = await monthScoreboard(q, month);
    const now = await nowItems(q, ctx.today);
    // whose merchant each line is, for a manager who sees more than their own book
    const owners: Record<string, string> =
      manager && now.length > 0
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
    const due = await dueCount(q, ctx.today);
    const reps = await repScorecard(q, month, ctx.today);
    const meters = manager ? await emailMeters(q) : [];
    return { ctx, month, score, now, due, owners, reps, meters };
  });
  const { ctx, month, score, now, due, owners, reps, meters } = data;
  const monthName = `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

  return (
    <div className="space-y-6">
      {denied ? (
        <p
          role="status"
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-muted"
        >
          That page isn&apos;t available, so you&apos;re back on the Dashboard.
        </p>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Dashboard</h1>
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
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Kpi label="New leads" value={score.new_leads} sub={monthName} />
        <Kpi label="Applications in" value={score.apps_in} sub={monthName} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="min-w-0 space-y-3">
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
        <aside className="min-w-0 space-y-6">
          <RepTable rows={reps} month={monthName} mine={!manager} />
          <Meters meters={meters} />
        </aside>
      </div>
    </div>
  );
}
