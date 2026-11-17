import type { DbAccess } from "../db";
import type { ISODate } from "../mca/dates";

/**
 * The statement clock, run by the nightly job. When a newer month's statement becomes expected (the 5th: see
 * expectedMonth in src/lib/docs/freshness.ts), every merchant being chased for documents gets that month on their
 * checklist, once, and moves to the bucket the checklist now says (db/migrations/0544). Returns how many merchants
 * were asked for a new month.
 */
export async function runStatementClock(db: DbAccess, today?: ISODate): Promise<number> {
  return db.withSystem(async (q) => {
    const { rows } = await q.query<{ n: number }>(
      "select request_new_month_statements(coalesce($1::date, current_date)) as n",
      [today ?? null],
    );
    return rows[0]?.n ?? 0;
  });
}
