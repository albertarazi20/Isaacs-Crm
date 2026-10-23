import type { Db } from "../db";
import { addDays, type ISODate } from "../mca/dates";
import type { StageKey } from "../mca/stages";
import type { ReportClient, TimerHistory } from "./report";

export const REPORT_PERIODS = [
  { key: "30", label: "30 days", days: 30 },
  { key: "90", label: "90 days", days: 90 },
  { key: "365", label: "1 year", days: 365 },
  { key: "all", label: "All time", days: null },
] as const;

export type ReportPeriod = (typeof REPORT_PERIODS)[number]["key"];

export function parsePeriod(raw: string | undefined): ReportPeriod {
  return REPORT_PERIODS.find((p) => p.key === raw)?.key ?? "90";
}

interface ClientRow {
  id: string;
  source: string;
  stage: StageKey;
  created_at: string;
  reached: Partial<Record<StageKey, string>>;
  funded_cents: number;
  advances: number;
}

/** Merchants ADDED in the period (a cohort), with the first time each reached each stage. Trash is left out. */
export async function loadCohort(q: Db, since: ISODate | null): Promise<ReportClient[]> {
  const { rows } = await q.query<ClientRow>(
    `select c.id, c.source, c.stage, c.created_at,
            coalesce((select jsonb_object_agg(s.to_stage, s.first_at)
                        from (select a.to_stage, min(a.occurred_at) as first_at
                                from activities a
                               where a.client_id = c.id and a.to_stage is not null
                               group by a.to_stage) s), '{}'::jsonb) as reached,
            (select coalesce(sum(f.amount_cents), 0) from fundings f where f.client_id = c.id) as funded_cents,
            (select count(*) from fundings f where f.client_id = c.id)::int as advances
       from clients c
      where ($1::date is null or c.created_at >= $1::date)
        and not exists (select 1 from trashed_clients t where t.client_id = c.id)
      order by c.created_at`,
    [since],
  );
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    stage: r.stage,
    createdAt: r.created_at,
    reached: r.reached,
    fundedCents: Number(r.funded_cents),
    advances: r.advances,
  }));
}

interface TimerRow {
  due_on: ISODate;
  done_on: ISODate | null;
  done_reason: TimerHistory["doneReason"];
}

/** Timers that came due in the window, with the day each was closed in the user's own time zone. */
export async function loadTimerHistory(
  q: Db,
  today: ISODate,
  days: number | null,
  timezone: string,
): Promise<TimerHistory[]> {
  const from = days === null ? null : addDays(today, -days);
  const { rows } = await q.query<TimerRow>(
    `select t.due_on, (t.done_at at time zone $3)::date as done_on, t.done_reason
       from timers t
      where t.due_on <= $1::date
        and ($2::date is null or t.due_on >= $2::date)
        and not exists (select 1 from trashed_clients tc where tc.client_id = t.client_id)`,
    [today, from, timezone],
  );
  return rows.map((r) => ({ dueOn: r.due_on, doneOn: r.done_on, doneReason: r.done_reason }));
}
