import { ReportView } from "@/components/reports/ReportView";
import { requireSession } from "@/lib/auth/server";
import { userContext } from "@/lib/data/queries";
import { db } from "@/lib/db";
import { addDays } from "@/lib/mca/dates";
import { loadCohort, loadTimerHistory, parsePeriod, REPORT_PERIODS } from "@/lib/reports/queries";
import {
  buildDeathPoints,
  buildDiscipline,
  buildFunnel,
  buildSources,
  buildSpeed,
} from "@/lib/reports/report";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const session = await requireSession();
  const period = parsePeriod((await searchParams).days);
  const days = REPORT_PERIODS.find((p) => p.key === period)?.days ?? null;
  const { cohort, timers, today } = await db.withUser(session.userId, async (q) => {
    const ctx = await userContext(q);
    const since = days === null ? null : addDays(ctx.today, -days);
    return {
      today: ctx.today,
      cohort: await loadCohort(q, since),
      timers: await loadTimerHistory(q, ctx.today, days, ctx.timezone),
    };
  });
  return (
    <ReportView
      period={period}
      added={cohort.length}
      discipline={buildDiscipline(timers, today)}
      funnel={buildFunnel(cohort)}
      deaths={buildDeathPoints(cohort)}
      speed={buildSpeed(cohort)}
      sources={buildSources(cohort)}
    />
  );
}
