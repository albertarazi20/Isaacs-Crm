import Link from "next/link";
import { OverviewRecommendations } from "@/components/assistant/OverviewRecommendations";
import { QueueList } from "@/components/dashboard/QueueList";
import { WeeklyChart } from "@/components/dashboard/WeeklyChart";
import { CountUp } from "@/components/fx";
import { Glyph, type GlyphName } from "@/components/shell/icons";
import { NewLeadButton } from "@/components/shell/NewLead";
import { Avatar, Delta, LinkButton, Meter, PageHeader, Sparkline, cn } from "@/components/ui";
import { CAN } from "@/lib/auth/roles";
import { requireSession } from "@/lib/auth/server";
import { monthOf, type EmailMeter } from "@/lib/dashboard/queries";
import { loadRecommendations } from "@/lib/assistant/recommendations";
import { loadShell } from "@/lib/data/shell";
import { env } from "@/lib/env";
import { assistantState } from "@/lib/leads/assistant";
import { gmailStatus } from "@/lib/system/gmail";
import { db } from "@/lib/db";
import { formatDate, timeAgo } from "@/lib/format";
import {
  loadOverview,
  type ActivityEvent,
  type ActivityKind,
  type FunnelStep,
  type Overview,
  type RepRow,
} from "@/lib/followup/overview";
import { parseISODate } from "@/lib/mca/dates";
import { requestTimeMs } from "@/lib/server-time";

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
const monthName = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1] ?? "";

/** Month against last month, as a whole percent. Null when there is nothing to compare with. */
const change = (now: number, before: number): number | null =>
  before === 0 ? null : Math.round(((now - before) / before) * 100);

/** "9 min", "2.5 h", "3 d": how long a new lead waits for its first touch. */
function waitText(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 1) return "<1 min";
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours * 10) / 10} h`;
  return `${Math.round((hours / 24) * 10) / 10} d`;
}

function greeting(nowMs: number, timezone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone }).format(
      new Date(nowMs),
    ),
  );
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function Panel({
  title,
  aside,
  children,
  className,
  flush,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** The body runs edge to edge (lists, tables). */
  flush?: boolean;
}) {
  return (
    <section className={cn("flex flex-col rounded-2xl border border-border bg-surface", className)}>
      <header className="flex shrink-0 items-center justify-between gap-3 px-4 pt-4 pb-3 sm:px-5">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {aside}
      </header>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          flush ? "overflow-hidden rounded-b-2xl" : "px-4 pb-4 sm:px-5 sm:pb-5",
        )}
      >
        {children}
      </div>
    </section>
  );
}

function HeroStat({
  label,
  value,
  before,
  beforeLabel,
  spark,
  hero,
  tone,
}: {
  label: string;
  value: number;
  before: number;
  beforeLabel: string;
  spark?: number[];
  hero?: boolean;
  tone: "accent" | "info" | "good";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-surface p-4 sm:p-5",
        hero && "ring-brand bg-brand-soft",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="eyebrow">{label}</p>
        {value === 0 && before === 0 ? null : <Delta value={change(value, before)} />}
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p
          className={cn(
            "text-[40px] leading-none font-semibold tracking-[-0.045em]",
            hero && "text-gradient",
          )}
        >
          <CountUp value={value} />
        </p>
        {spark && spark.some((v) => v > 0) ? (
          <span className="hidden sm:block">
            <Sparkline values={spark} tone={tone} width={96} height={36} className="mb-1" />
          </span>
        ) : null}
      </div>
      <p className="mt-2.5 text-xs text-muted">
        <span className="tabular-nums">{before}</span> in {beforeLabel}
      </p>
    </div>
  );
}

function Pulse({
  icon,
  label,
  value,
  hint,
  tone,
  href,
}: {
  icon: GlyphName;
  label: string;
  value: string;
  hint: string;
  tone: "warn" | "accent" | "good" | "info";
  href?: string;
}) {
  const ink = { warn: "text-warn", accent: "text-accent", good: "text-good", info: "text-info" }[
    tone
  ];
  const chip = {
    warn: "bg-warn-soft ring-warn/20",
    accent: "bg-accent-soft ring-accent/25",
    good: "bg-good-soft ring-good/20",
    info: "bg-info-soft ring-info/20",
  }[tone];
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset",
          chip,
          ink,
        )}
      >
        <Glyph name={icon} className="size-[18px]" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-muted">{label}</span>
        <span className="block text-xl leading-tight font-semibold tracking-tight tabular-nums">
          {value}
        </span>
        <span className="block truncate text-[11.5px] text-muted">{hint}</span>
      </span>
    </>
  );
  const cls = "flex items-center gap-3 px-4 py-3.5 sm:px-5";
  return href ? (
    <Link href={href} className={cn(cls, "transition duration-150 hover:bg-surface-2/50")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Funnel({ steps }: { steps: FunnelStep[] }) {
  const top = Math.max(1, steps[0]?.count ?? 0);
  return (
    <ol className="space-y-3.5">
      {steps.map((s, i) => {
        const pct = Math.round((s.count / top) * 100);
        const prev = i > 0 ? (steps[i - 1]?.count ?? 0) : 0;
        const carried = i > 0 && prev > 0 ? Math.round((s.count / prev) * 100) : null;
        return (
          <li key={s.key}>
            <div className="flex items-baseline justify-between gap-2 text-[13px]">
              <span className="font-medium">{s.label}</span>
              <span className="flex items-baseline gap-2">
                {carried !== null ? (
                  <span className="text-[11.5px] text-muted tabular-nums">{carried}% carried</span>
                ) : null}
                <span className="font-semibold tabular-nums">{s.count}</span>
              </span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-700 ease-out",
                  i === steps.length - 1 ? "bg-brand shadow-glow" : "bg-accent/55",
                )}
                style={{ width: `${Math.max(s.count > 0 ? 3 : 0, pct)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const ACT: Record<ActivityKind, { icon: GlyphName; ink: string }> = {
  reply: { icon: "reply", ink: "text-accent" },
  upload: { icon: "file", ink: "text-good" },
  signed: { icon: "check", ink: "text-good" },
  email_sent: { icon: "send", ink: "text-info" },
  handed_off: { icon: "flag", ink: "text-accent" },
  lead_added: { icon: "plus", ink: "text-text-2" },
  bounced: { icon: "alert", ink: "text-bad" },
};

function Activity({ events, now }: { events: ActivityEvent[]; now: Date }) {
  if (events.length === 0)
    return <p className="py-6 text-center text-sm text-muted">Nothing has happened yet today.</p>;
  return (
    <ol className="relative space-y-0.5">
      <span aria-hidden className="absolute top-3 bottom-3 left-[15px] w-px bg-border" />
      {events.map((e, i) => {
        const a = ACT[e.kind];
        return (
          <li key={`${e.at}-${e.clientId}-${i}`} className={i >= 6 ? "max-sm:hidden" : undefined}>
            <Link
              href={`/clients/${e.clientId}`}
              className="relative flex items-start gap-3 rounded-xl py-2 pr-2 transition duration-150 hover:bg-surface-2/50"
            >
              <span
                aria-hidden
                className={cn(
                  "relative z-10 flex size-[31px] shrink-0 items-center justify-center rounded-full border border-border bg-surface",
                  a.ink,
                )}
              >
                <Glyph name={a.icon} className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 pt-0.5">
                <span className="block truncate text-[13px] font-medium">{e.businessName}</span>
                <span className="block truncate text-[12.5px] text-muted">{e.text}</span>
              </span>
              <span className="shrink-0 pt-1 text-[11.5px] text-muted tabular-nums">
                {timeAgo(e.at, now)}
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

function Team({ rows }: { rows: RepRow[] }) {
  const best = Math.max(1, ...rows.map((r) => r.broughtIn));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-[13px]">
        <thead>
          <tr className="border-y border-border bg-surface-3/50 text-left">
            <th className="eyebrow py-2.5 pr-3 pl-4 font-semibold sm:pl-5">Rep</th>
            <th className="eyebrow px-3 py-2.5 text-right font-semibold">Leads</th>
            <th className="eyebrow px-3 py-2.5 text-right font-semibold">Replied</th>
            <th className="eyebrow px-3 py-2.5 text-right font-semibold">Docs in</th>
            <th className="eyebrow px-3 py-2.5 font-semibold">Brought in</th>
            <th className="eyebrow px-3 py-2.5 text-right font-semibold">Overdue</th>
            <th className="eyebrow py-2.5 pr-4 pl-3 text-right font-semibold sm:pr-5">
              First touch
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.userId} className="transition duration-150 hover:bg-surface-2/40">
              <td className="py-2.5 pr-3 pl-4 sm:pl-5">
                <span className="flex items-center gap-2.5">
                  <Avatar name={r.name} size={28} />
                  <span className="truncate font-medium">{r.name}</span>
                </span>
              </td>
              <td className="px-3 py-2.5 text-right">{r.newLeads}</td>
              <td className="px-3 py-2.5 text-right">{r.replied}</td>
              <td className="px-3 py-2.5 text-right">{r.docsIn}</td>
              <td className="px-3 py-2.5">
                <span className="flex items-center gap-2.5">
                  <span className="w-6 text-right font-semibold">{r.broughtIn}</span>
                  <span className="w-20 shrink-0">
                    <Meter value={r.broughtIn} max={best} tone="brand" />
                  </span>
                </span>
              </td>
              <td
                className={cn("px-3 py-2.5 text-right", r.overdue > 0 && "font-semibold text-warn")}
              >
                {r.overdue}
              </td>
              <td className="py-2.5 pr-4 pl-3 text-right text-muted sm:pr-5">
                {waitText(r.speedToLeadMinutes)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sending({ meters }: { meters: EmailMeter[] }) {
  return (
    <ul className="space-y-4">
      {meters.map((m) => (
        <li key={m.mailbox_id}>
          <div className="flex items-baseline justify-between gap-2 text-[13px]">
            <span className="min-w-0 truncate font-medium">
              {m.owner_name ?? (m.kind === "resend" ? "Shop sender" : m.address)}
            </span>
            <span className="shrink-0 text-xs text-muted tabular-nums">
              {m.sent_24h} of {m.cap}
            </span>
          </div>
          <Meter
            value={m.sent_24h}
            max={m.cap}
            tone={m.tone === "red" ? "bad" : m.tone === "amber" ? "warn" : "good"}
            className="mt-1.5"
          />
          <p className="mt-1 truncate text-[11.5px] text-muted">{m.address}</p>
        </li>
      ))}
    </ul>
  );
}

function body(o: Overview, now: Date, manager: boolean) {
  const { kpis } = o;
  const last = monthName(kpis.lastMonth.month);
  const leads = o.series.map((w) => w.newLeads);
  const wins = o.series.map((w) => w.broughtIn);
  const ready = o.buckets.find((b) => b.key === "ready_for_ops");
  const topBucket = Math.max(1, ...o.buckets.map((b) => b.count));
  const leadSum = leads.reduce((a, b) => a + b, 0);
  const winSum = wins.reduce((a, b) => a + b, 0);
  return (
    <>
      <div className="stagger grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <HeroStat
          label="Brought in"
          value={kpis.thisMonth.broughtIn}
          before={kpis.lastMonth.broughtIn}
          beforeLabel={last}
          spark={wins}
          tone="accent"
          hero
        />
        <HeroStat
          label="New leads"
          value={kpis.thisMonth.newLeads}
          before={kpis.lastMonth.newLeads}
          beforeLabel={last}
          spark={leads}
          tone="info"
        />
        <HeroStat
          label="Replied"
          value={kpis.thisMonth.replied}
          before={kpis.lastMonth.replied}
          beforeLabel={last}
          tone="accent"
        />
        <HeroStat
          label="Docs in"
          value={kpis.thisMonth.docsIn}
          before={kpis.lastMonth.docsIn}
          beforeLabel={last}
          tone="good"
        />
      </div>

      <section
        aria-label="Right now"
        className="grid animate-rise grid-cols-1 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4"
      >
        <Pulse
          icon="reply"
          label="Replies waiting"
          value={String(kpis.replyWaiting)}
          hint="Merchants who wrote back"
          tone="accent"
        />
        <Pulse
          icon="clock"
          label="Follow-ups overdue"
          value={String(kpis.overdue)}
          hint="Open the call list"
          tone="warn"
          href="/today"
        />
        <Pulse
          icon="flag"
          label="Ready to hand off"
          value={String(kpis.readyToHandOff)}
          hint="Docs and application are in"
          tone="good"
          href={ready ? `/follow-up?b=${ready.id}` : "/follow-up"}
        />
        <Pulse
          icon="zap"
          label="First touch"
          value={waitText(kpis.speedToLeadMinutes)}
          hint="Median wait for a new lead"
          tone="info"
        />
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,3fr)]">
        <div className="relative xl:min-h-[520px]">
          <Panel
            title="Do this now"
            flush
            className="xl:absolute xl:inset-0"
            aside={
              <span className="inline-flex items-center gap-2 text-xs text-muted">
                {o.queue.length > 0 ? <span className="live-dot text-accent" /> : null}
                {o.queue.length} waiting
              </span>
            }
          >
            <QueueList items={o.queue} />
          </Panel>
        </div>

        <div className="space-y-4 sm:space-y-5">
          <Panel
            title="This month's leads"
            aside={<span className="text-xs text-muted">How far they got</span>}
          >
            <Funnel steps={o.funnel} />
          </Panel>
          <Panel
            title="Buckets"
            aside={
              <Link
                href="/follow-up"
                className="inline-flex items-center gap-1 text-xs font-medium text-accent transition hover:text-accent-strong"
              >
                Open Follow Up
                <Glyph name="arrowRight" className="size-3.5" />
              </Link>
            }
          >
            <ul className="-mx-2 space-y-0.5">
              {o.buckets.map((b) => (
                <li key={b.id}>
                  <Link
                    href={`/follow-up?b=${b.id}`}
                    className="flex items-center gap-3 rounded-xl px-2 py-2 text-[13px] transition duration-150 hover:bg-surface-2/50"
                  >
                    <span className="min-w-0 flex-1 truncate">{b.name}</span>
                    <span className="w-24 shrink-0">
                      <Meter value={b.count} max={topBucket} tone="accent" />
                    </span>
                    <span className="w-8 text-right font-semibold tabular-nums">{b.count}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,3fr)]">
        <Panel
          title="Last 8 weeks"
          aside={
            <span className="flex items-center gap-3 text-xs text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-muted/60" /> Leads
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="bg-brand size-2 rounded-full" /> Brought in
              </span>
            </span>
          }
        >
          <WeeklyChart series={o.series} />
          <dl className="mt-4 grid grid-cols-3 divide-x divide-border rounded-xl border border-border bg-surface-3/50">
            {[
              { k: "Leads", v: String(leadSum) },
              { k: "Brought in", v: String(winSum) },
              {
                k: "Conversion",
                v: leadSum > 0 ? `${Math.round((winSum / leadSum) * 100)}%` : "—",
              },
            ].map((x) => (
              <div key={x.k} className="px-3 py-3 sm:px-4">
                <dt className="text-[11.5px] text-muted">{x.k}</dt>
                <dd className="mt-0.5 text-lg font-semibold tracking-tight tabular-nums">{x.v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <div className="relative xl:min-h-[420px]">
          <Panel
            title="Latest"
            aside={<span className="text-xs text-muted">Across your book</span>}
            className="xl:absolute xl:inset-0"
          >
            <div className="min-h-0 flex-1 overflow-y-auto xl:-mr-2 xl:pr-2">
              <Activity events={o.activity} now={now} />
            </div>
          </Panel>
        </div>
      </div>

      {manager && o.reps && o.reps.length > 0 ? (
        <div
          className={cn(
            "grid grid-cols-[minmax(0,1fr)] gap-4 sm:gap-5",
            o.email.length > 0 && "xl:grid-cols-[minmax(0,5fr)_minmax(0,3fr)]",
          )}
        >
          <Panel
            title="Team"
            flush
            aside={<span className="text-xs text-muted">{monthName(o.month)}</span>}
            className="overflow-hidden"
          >
            <Team rows={o.reps} />
          </Panel>
          {o.email.length > 0 ? (
            <Panel
              title="Sending today"
              aside={<span className="text-xs text-muted">Last 24 hours</span>}
            >
              <Sending meters={o.email} />
            </Panel>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const { denied } = await searchParams;
  const session = await requireSession();
  const manager = CAN.seeEveryone(session.role);
  const me = await loadShell(session.userId);
  const gmail = await gmailStatus(session.userId);
  const { overview, recommendations, assistant } = await db.withUser(session.userId, async (q) => ({
    overview: await loadOverview(q, { today: me.ctx.today, month: monthOf(me.ctx.today), manager }),
    recommendations: await loadRecommendations(q, {
      today: me.ctx.today,
      manager,
      gmailConnected: gmail.connected,
    }),
    assistant: await assistantState(q, Boolean(env().ANTHROPIC_API_KEY)),
  }));
  const nowMs = requestTimeMs();
  const first = (me.user?.name || me.user?.email.split("@")[0] || "").split(" ")[0];
  const { kpis } = overview;
  const waiting = kpis.replyWaiting + kpis.overdue;

  return (
    <div className="space-y-4 sm:space-y-5">
      {denied ? (
        <p
          role="status"
          className="rounded-2xl border border-border bg-surface-2 px-4 py-2.5 text-sm text-muted"
        >
          That page isn&apos;t available, so you&apos;re back on the Overview.
        </p>
      ) : null}
      <div className="animate-rise pb-1">
        <PageHeader
          eyebrow={`${WEEKDAYS[parseISODate(me.ctx.today).getUTCDay()]}, ${formatDate(me.ctx.today)}`}
          title={
            <>
              {greeting(nowMs, me.ctx.timezone)}
              {first ? (
                <>
                  , <span className="text-gradient">{first}</span>
                </>
              ) : null}
            </>
          }
          description={
            waiting > 0
              ? `${kpis.replyWaiting} ${kpis.replyWaiting === 1 ? "reply is" : "replies are"} waiting and ${kpis.overdue} follow-up${kpis.overdue === 1 ? " is" : "s are"} past due. ${kpis.readyToHandOff} ready to hand off.`
              : `You are caught up. ${kpis.readyToHandOff} ready to hand off.`
          }
          actions={
            <>
              {me.due > 0 ? (
                <LinkButton href="/today">
                  <Glyph name="phone" className="size-4" />
                  Call list
                  <span className="rounded-full bg-accent-soft px-1.5 text-[11px] text-accent tabular-nums">
                    {me.due}
                  </span>
                </LinkButton>
              ) : null}
              <span className="lg:hidden">
                <NewLeadButton />
              </span>
            </>
          }
        />
      </div>
      <OverviewRecommendations items={recommendations} ready={assistant.ready} />
      {body(overview, new Date(nowMs), manager)}
    </div>
  );
}
