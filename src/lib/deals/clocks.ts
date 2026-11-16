import type { Db } from "../db";

/**
 * The deal's nightly clocks (S2-2), one call for the cron route, on the owner connection the route already holds
 * (the same way it runs roll_funding_clocks):
 *   expire_approvals             — approvals past their date become expired (lender row, open offers, timeline, rep alert)
 *   request_new_month_statements — merchants with an open deal get the newest statement month on their checklist,
 *                                  which re-buckets them and sends the reminder
 * `today` defaults to the database's own day so the SQL date guards and this agree.
 */
export interface DealClocksSummary {
  today: string;
  expired: number;
  statementsRequested: number;
}

export async function runDealClocks(
  q: Db,
  opts: { today?: string } = {},
): Promise<DealClocksSummary> {
  const today =
    opts.today ??
    ((await q.query<{ d: string }>("select current_date::text as d")).rows[0]?.d as string);
  const expired = (await q.query<{ n: number }>("select expire_approvals($1::date) as n", [today]))
    .rows[0]?.n;
  const requested = (
    await q.query<{ n: number }>("select request_new_month_statements($1::date) as n", [today])
  ).rows[0]?.n;
  return { today, expired: expired ?? 0, statementsRequested: requested ?? 0 };
}
