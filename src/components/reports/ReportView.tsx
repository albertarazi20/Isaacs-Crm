import Link from "next/link";
import { REPORT_PERIODS, type ReportPeriod } from "@/lib/reports/queries";
import type { DeathPoint, Discipline, FunnelRow, SourceRow, SpeedRow } from "@/lib/reports/report";
import { MIN_SAMPLE } from "@/lib/reports/report";
import { formatMoneyCompact } from "@/lib/money";
import { Card, cn, EmptyState, SectionTitle } from "../ui";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ReportView({
  period,
  added,
  discipline,
  funnel,
  deaths,
  speed,
  sources,
}: {
  period: ReportPeriod;
  added: number;
  discipline: Discipline;
  funnel: FunnelRow[];
  deaths: DeathPoint[];
  speed: SpeedRow[];
  sources: SourceRow[];
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="mt-1 text-sm text-muted">
            Where deals stall, which lead sources pay, and whether the follow-ups got done.
          </p>
        </div>
        <nav aria-label="Period" className="inline-flex rounded-lg bg-surface-2 p-0.5">
          {REPORT_PERIODS.map((p) => (
            <Link
              key={p.key}
              href={`/reports?days=${p.key}`}
              aria-current={p.key === period ? "page" : undefined}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm",
                p.key === period
                  ? "bg-surface font-medium shadow-sm"
                  : "text-muted hover:text-text",
              )}
            >
              {p.label}
            </Link>
          ))}
        </nav>
      </div>

      <DisciplineCard d={discipline} />

      {added === 0 ? (
        <EmptyState title="No merchants added in this period">
          Pick a longer period, or add merchants and come back.
        </EmptyState>
      ) : (
        <>
          <FunnelCard rows={funnel} added={added} />
          <div className="grid gap-5 lg:grid-cols-2">
            <DeathsCard rows={deaths} />
            <SpeedCard rows={speed} />
          </div>
          <SourcesCard rows={sources} />
        </>
      )}
    </div>
  );
}

function DisciplineCard({ d }: { d: Discipline }) {
  if (d.total === 0 || d.onTimeRate === null)
    return (
      <Card className="p-4">
        <SectionTitle>Follow-ups done on time</SectionTitle>
        <p className="mt-2 text-sm text-muted">
          Nothing has come due in this period yet. This fills in as follow-ups come due.
        </p>
      </Card>
    );
  const parts = [
    { key: "onTime", n: d.onTime, label: "Done on the day", cls: "bg-good" },
    { key: "late", n: d.late, label: "Done late", cls: "bg-warn" },
    { key: "pushed", n: d.pushed, label: "Pushed back", cls: "bg-muted/50" },
    { key: "overdue", n: d.overdue, label: "Still overdue", cls: "bg-bad" },
  ];
  return (
    <Card className="space-y-3 p-4">
      <SectionTitle>Follow-ups done on time</SectionTitle>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-4xl font-bold tabular-nums">{d.onTimeRate}%</p>
        <p className="text-sm text-muted">
          of {plural(d.total, "follow-up")} that came due were done on the day.
        </p>
      </div>
      {d.total < 5 ? (
        <p className="text-sm text-muted">
          Only {plural(d.total, "follow-up")} so far — a first look, not a trend.
        </p>
      ) : null}
      <div
        role="img"
        aria-label={parts.map((p) => `${p.label}: ${p.n}`).join(", ")}
        className="flex h-3 overflow-hidden rounded-full bg-surface-2"
      >
        {parts
          .filter((p) => p.n > 0)
          .map((p) => (
            <div key={p.key} className={p.cls} style={{ width: `${(p.n / d.total) * 100}%` }} />
          ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <span className={cn("inline-block h-2.5 w-2.5 rounded-full", p.cls)} />
            {p.label} <strong className="tabular-nums">{p.n}</strong>
          </li>
        ))}
      </ul>
      {d.pushed > d.onTime && d.pushed >= 5 ? (
        <p className="rounded-lg bg-surface-2 p-3 text-sm">
          More follow-ups were pushed back than done on the day. Pushing the same merchant back
          again and again is how deals go cold.
        </p>
      ) : null}
    </Card>
  );
}

function FunnelCard({ rows, added }: { rows: FunnelRow[]; added: number }) {
  return (
    <Card className="space-y-3 p-4">
      <SectionTitle>From added to funded</SectionTitle>
      <p className="text-sm text-muted">
        The {plural(added, "merchant")} you added in this period, and how far each one got. Recent
        merchants haven&apos;t had time to fund yet, so a short period looks worse than it is.
      </p>
      <ol className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.key}
            className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-sm"
          >
            <span className="truncate">{r.label}</span>
            <div className="h-5 overflow-hidden rounded bg-surface-2">
              <div
                className="h-full rounded bg-accent"
                style={{ width: `${r.ofAdded}%`, minWidth: r.count > 0 ? 4 : 0 }}
              />
            </div>
            <span className="whitespace-nowrap text-right tabular-nums">
              <strong>{r.count}</strong>{" "}
              <span className="text-muted">
                {r.ofPrevious === null ? "" : `${r.ofPrevious}% of the step before`}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function DeathsCard({ rows }: { rows: DeathPoint[] }) {
  return (
    <Card className="space-y-3 p-4">
      <SectionTitle>Where deals ended</SectionTitle>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing has ended yet (declined, lost, killed, dead or not interested).
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">
            Merchants now in Lost deal or Trash (which holds Declined, Killed, Dead and Not
            interested), by the furthest step they reached.
          </p>
          <ul className="space-y-1.5 text-sm">
            {rows.map((r) => (
              <li key={r.label} className="flex justify-between gap-3">
                <span>{r.label}</span>
                <strong className="tabular-nums">{r.count}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function SpeedCard({ rows }: { rows: SpeedRow[] }) {
  return (
    <Card className="space-y-3 p-4">
      <SectionTitle>How fast deals move</SectionTitle>
      <p className="text-sm text-muted">
        Only merchants you added at the start of the pipeline. Imported ones are left out — they
        arrived already part-way.
      </p>
      <ul className="space-y-1.5 text-sm">
        {rows.map((r) => (
          <li key={r.label} className="flex justify-between gap-3">
            <span>{r.label}</span>
            {r.medianDays === null ? (
              <span className="text-muted">
                not enough yet ({r.n} of {MIN_SAMPLE})
              </span>
            ) : (
              <span className="tabular-nums">
                <strong>{r.medianDays < 1 ? "under a day" : `${r.medianDays} days`}</strong>{" "}
                <span className="text-muted">median of {r.n}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SourcesCard({ rows }: { rows: SourceRow[] }) {
  return (
    <Card className="space-y-3 p-4">
      <SectionTitle>Lead sources</SectionTitle>
      <p className="text-sm text-muted">
        Spelling and capital letters don&apos;t split a source. Funded counts merchants who got an
        advance; the dollars are everything funded to them.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted">
              <th className="py-1.5 pr-3 font-medium">Source</th>
              <th className="px-3 py-1.5 text-right font-medium">Added</th>
              <th className="px-3 py-1.5 text-right font-medium">Interested</th>
              <th className="px-3 py-1.5 text-right font-medium">Funded</th>
              <th className="px-3 py-1.5 text-right font-medium">Funded rate</th>
              <th className="py-1.5 pl-3 text-right font-medium">Funded $</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.source} className="border-b border-border/60 last:border-0">
                <td className="py-1.5 pr-3">{r.source}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.added}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.interested}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{r.funded}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {r.rate}%
                  {r.small ? (
                    <span
                      className="ml-1 text-xs text-muted"
                      title="Fewer than 5 merchants — a hunch, not a trend"
                    >
                      (small)
                    </span>
                  ) : null}
                </td>
                <td className="py-1.5 pl-3 text-right tabular-nums">
                  {r.fundedCents > 0 ? formatMoneyCompact(r.fundedCents) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
