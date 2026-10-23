import type { Db, DbAccess } from "../db";
import { addDays, parseISODate, todayIn, type ISODate } from "../mca/dates";
import { buildScorecard, type ScorecardInput } from "../mca/scorecard";
import { loadTimerHistory } from "../reports/queries";
import { buildDiscipline } from "../reports/report";
import type { DigestSender } from "./reminders";

export interface WeeklySummary {
  users: number;
  sent: number;
  skipped: number;
  failed: number;
}

interface UserRow {
  id: string;
  email: string;
  notify_email: string | null;
  timezone: string;
  digest_hour: number;
}

const localHour = (timezone: string, now: Date): number =>
  Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (d: ISODate) => {
  const p = parseISODate(d);
  return `${MONTHS[p.getUTCMonth()]} ${p.getUTCDate()}`;
};

/** Last week's numbers for one user. Runs through RLS (`withUser`), so it can only ever see that user's rows. */
export async function loadScorecard(
  q: Db,
  today: ISODate,
  timezone: string,
): Promise<ScorecardInput> {
  const from = addDays(today, -7);
  const to = addDays(today, -1);
  const one = async <T>(sql: string, params: unknown[]): Promise<T> =>
    (await q.query<{ v: T }>(sql, params)).rows[0]?.v as T;

  const timers = await loadTimerHistory(q, today, 7, timezone);
  const added = await one<number>(
    `select count(*)::int as v from clients c
      where c.created_at >= ($1::date::timestamp at time zone $3) and c.created_at < ($2::date::timestamp at time zone $3)
        and not exists (select 1 from trashed_clients t where t.client_id = c.id)`,
    [from, today, timezone],
  );
  const { rows: funded } = await q.query<{ n: number; cents: number }>(
    `select count(*)::int as n, coalesce(sum(f.amount_cents), 0)::bigint as cents from fundings f
      where f.funded_on between $1::date and $2::date
        and not exists (select 1 from trashed_clients t where t.client_id = f.client_id)`,
    [from, to],
  );
  const commission = await one<number>(
    `select coalesce(sum(f.commission_received_cents), 0)::bigint as v from fundings f
      where f.commission_received_on between $1::date and $2::date
        and not exists (select 1 from trashed_clients t where t.client_id = f.client_id)`,
    [from, to],
  );
  const { rows: overdue } = await q.query<{
    id: string;
    business_name: string;
    wanted_amount_cents: number | null;
    days: number;
  }>(
    `select id, business_name, wanted_amount_cents, ($1::date - next_due_on)::int as days
       from client_cards
      where next_due_on < $1::date and contact_status = 'ok'
      order by wanted_amount_cents desc nulls last, next_due_on, business_name
      limit 5`,
    [today],
  );
  const overdueTotal = await one<number>(
    "select count(*)::int as v from client_cards where next_due_on < $1::date and contact_status = 'ok'",
    [today],
  );
  return {
    weekLabel: `${short(from)} – ${short(to)}`,
    discipline: buildDiscipline(timers, today),
    added,
    funded: { count: funded[0]?.n ?? 0, cents: Number(funded[0]?.cents ?? 0) },
    commissionReceivedCents: Number(commission),
    overdue: overdue.map((o) => ({
      clientId: o.id,
      businessName: o.business_name,
      wantedCents: o.wanted_amount_cents === null ? null : Number(o.wanted_amount_cents),
      daysOverdue: o.days,
    })),
    overdueTotal,
  };
}

/**
 * Sends each user their weekly scorecard on Monday morning (their own Monday, after their digest hour).
 * Claim-then-send: one row per user per Monday, rolled back if the send fails, so the next hourly run retries.
 */
export async function runWeeklyScorecards(args: {
  db: DbAccess;
  now: Date;
  appUrl: string;
  send: DigestSender;
  /** Who may still receive email (see runReminders). Default: everyone. */
  allowed?: (loginEmail: string) => boolean;
}): Promise<WeeklySummary> {
  const users = await args.db.withSystem(
    async (q) =>
      (
        await q.query<UserRow>(
          "select id, email, notify_email, timezone, digest_hour from app_users where digest_enabled order by created_at",
        )
      ).rows,
  );
  const summary: WeeklySummary = { users: users.length, sent: 0, skipped: 0, failed: 0 };

  for (const user of users) {
    if (args.allowed && !args.allowed(user.email)) {
      summary.skipped += 1;
      continue;
    }
    const today = todayIn(user.timezone, args.now);
    const isMonday = parseISODate(today).getUTCDay() === 1;
    if (!isMonday || localHour(user.timezone, args.now) < user.digest_hour) {
      summary.skipped += 1;
      continue;
    }
    try {
      const sent = await args.db.withSystem(async (q) => {
        const claim = await q.query(
          "insert into reminders_sent (user_id, kind, for_date, ref) values ($1, 'weekly', $2, '') on conflict do nothing",
          [user.id, today],
        );
        if (claim.rowCount === 0) return false;
        const card = await args.db.withUser(user.id, (uq) =>
          loadScorecard(uq, today, user.timezone),
        );
        const providerId = await args.send(
          user.notify_email ?? user.email,
          buildScorecard(card, args.appUrl),
        );
        await q.query(
          "update reminders_sent set provider_id = $3 where user_id = $1 and kind = 'weekly' and for_date = $2 and ref = ''",
          [user.id, today, providerId],
        );
        return true;
      });
      if (sent) summary.sent += 1;
      else summary.skipped += 1;
    } catch (e) {
      summary.failed += 1;
      console.error(
        `weekly scorecard failed for user ${user.id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return summary;
}
