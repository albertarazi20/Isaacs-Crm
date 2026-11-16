import Link from "next/link";
import { Badge, cn } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import { TRUST_ALERT_KINDS, type TrustAlertLine } from "@/lib/settings/trust";
import type { BackdoorScore } from "@/lib/trust/queries";
import { SettingsCard, SHEET } from "./primitives";

const SHOWN = 8;

function scoreTone(score: number | null, reports: number): "bad" | "warn" | "neutral" {
  if (score === null || reports === 0) return "neutral";
  return score >= 5 ? "bad" : "warn";
}

function Rows({ rows }: { rows: BackdoorScore[] }) {
  return (
    <>
      {rows.map((r) => (
        <tr key={r.funder_id} className={SHEET.tr} data-lender-score={r.funder_id}>
          <td className={cn(SHEET.td, "max-w-56")}>
            <span className="block truncate font-medium">{r.name}</span>
            <span className="block text-xs text-muted sm:hidden">
              {r.files_sent} files sent · {r.reports} report{r.reports === 1 ? "" : "s"}
            </span>
          </td>
          <td className={cn(SHEET.tdNum, "max-sm:hidden")}>{r.files_sent}</td>
          <td className={cn(SHEET.tdNum, "max-sm:hidden")}>{r.reports}</td>
          <td className={SHEET.tdNum}>
            {r.score === null ? (
              <span className="text-muted">no files</span>
            ) : (
              <Badge tone={scoreTone(r.score, r.reports)}>
                {r.reports === 0 ? "clean" : `${r.score} per 100`}
              </Badge>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

/**
 * The backdoor score per lender (S2-12): backdoor reports against the files sent. A report names every lender who had
 * that merchant's file, so a lender that keeps turning up is the one to drop before the next shotgun.
 */
export function BackdoorScoresCard({ rows }: { rows: BackdoorScore[] }) {
  const head = rows.slice(0, SHOWN);
  const rest = rows.slice(SHOWN);
  const head2 = (
    <thead className={SHEET.thead}>
      <tr>
        <th className={SHEET.th}>Lender</th>
        <th className={cn(SHEET.thNum, "max-sm:hidden")}>Files sent</th>
        <th className={cn(SHEET.thNum, "max-sm:hidden")}>Reports</th>
        <th className={SHEET.thNum}>Backdoor score</th>
      </tr>
    </thead>
  );
  return (
    <SettingsCard
      title="Backdoor score per lender"
      description="When a merchant says they got a backdoor call, every lender who had their file carries the report. The score is reports per hundred files sent. Look here before you add a lender to a shotgun."
      aside={
        <Badge tone="neutral" className="tabular-nums">
          {rows.length}
        </Badge>
      }
      flush
      className="min-w-0 overflow-x-auto"
    >
      {rows.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted">No lenders yet.</p>
      ) : (
        <>
          <table className={cn(SHEET.table, "border-t border-border")}>
            {head2}
            <tbody className={SHEET.tbody}>
              <Rows rows={head} />
            </tbody>
          </table>
          {rest.length > 0 ? (
            <details className="border-t border-border">
              <summary className="cursor-pointer px-4 py-2.5 text-[13px] font-medium text-accent hover:underline">
                Show the other {rest.length}
              </summary>
              <table className={SHEET.table}>
                <tbody className={SHEET.tbody}>
                  <Rows rows={rest} />
                </tbody>
              </table>
            </details>
          ) : null}
        </>
      )}
    </SettingsCard>
  );
}

/** What each trust alert means, and the manager's own recent ones under it. */
export function TrustAlertsCard({ recent, nowMs }: { recent: TrustAlertLine[]; nowMs: number }) {
  const label = new Map(TRUST_ALERT_KINDS.map((k) => [k.key, k.label] as const));
  return (
    <SettingsCard
      title="Trust alerts"
      description="Every manager is told, by email and in the bell, when the hourly check sees one of these. Each is a question to ask, not a verdict."
      flush
    >
      <ul className="divide-y divide-border border-t border-border text-[13px]" data-trust-kinds>
        {TRUST_ALERT_KINDS.map((k) => (
          <li key={k.key} className="px-4 py-2.5" data-trust-kind={k.key}>
            <span className="font-semibold">{k.label}</span>
            <span className="block text-muted">{k.explain}</span>
          </li>
        ))}
      </ul>
      <div className="border-t border-border px-4 py-2.5 text-[11px] font-semibold tracking-wide text-muted uppercase">
        Yours in the last 30 days
      </div>
      {recent.length === 0 ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted">Nothing. All calm.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border text-[13px]">
          {recent.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-2.5"
            >
              <span className="min-w-0 flex-1 basis-56">
                <Badge tone="warn" className="mr-2">
                  {label.get(a.key)}
                </Badge>
                {a.href ? (
                  <Link href={a.href} className="font-medium hover:underline">
                    {a.title}
                  </Link>
                ) : (
                  <span className="font-medium">{a.title}</span>
                )}
              </span>
              <span className="shrink-0 text-xs whitespace-nowrap text-muted">
                {timeAgo(a.created_at, new Date(nowMs))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}
