import type { Db } from "../db";
import type { ISODate } from "../mca/dates";
import { buildStreak, streakStart, type CloseOfDay, type Streak } from "../mca/streak";

interface Row {
  day: ISODate;
  open: number;
}

/**
 * For each of the last days: how many follow-ups were due on or before that day, already existed, and were
 * still open when it ended (judged in the user's own time zone). Starts at the first follow-up ever created —
 * before that there was nothing to be behind on. Trashed merchants' timers were closed at trash time, so they
 * only count on days before that.
 */
export async function loadCloseOfDay(
  q: Db,
  today: ISODate,
  timezone: string,
): Promise<CloseOfDay[]> {
  const { rows } = await q.query<Row>(
    `with bounds as (
       select greatest($1::date, coalesce((select min((created_at at time zone $3)::date) from timers), $2::date)) as first_day
     ),
     days as (
       select d::date as day from bounds, generate_series(bounds.first_day, $2::date, '1 day') d
     ),
     candidates as (
       select t.due_on, (t.created_at at time zone $3)::date as created_day,
              (t.done_at at time zone $3)::date as done_day
         from timers t
        where t.done_at is null or (t.done_at at time zone $3)::date >= $1::date
     )
     select days.day, count(c.due_on)::int as open
       from days
       left join candidates c
         on c.due_on <= days.day
        and c.created_day <= days.day
        and (c.done_day is null or c.done_day > days.day)
      group by days.day
      order by days.day`,
    [streakStart(today), today, timezone],
  );
  return rows;
}

export async function loadStreak(q: Db, today: ISODate, timezone: string): Promise<Streak> {
  const days = await loadCloseOfDay(q, today, timezone);
  const { rows } = await q.query<{ n: number }>(
    "select count(*)::int as n from timers where done_at is null and due_on <= $1::date",
    [today],
  );
  return buildStreak(days, today, rows[0]?.n ?? 0);
}
