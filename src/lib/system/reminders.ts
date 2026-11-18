import type { Db, DbAccess } from "../db";
import { todayIn } from "../mca/dates";
import { buildCallReminder, buildDigest, type DueTimer } from "../mca/digest";
import { formatMoneyCompact } from "../money";
import type { StageKey, TimerKind } from "../mca/stages";

export type DigestSender = (
  to: string,
  digest: { subject: string; text: string; html: string },
) => Promise<string>;

export interface ReminderSummary {
  users: number;
  sent: number;
  skipped: number;
  failed: number;
}

function localHour(tz: string, now: Date): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    hourCycle: "h23",
  }).format(now);
  return Number(h);
}

function localTime(tz: string, at: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

interface UserRow {
  id: string;
  email: string;
  notify_email: string | null;
  timezone: string;
  digest_hour: number;
}

interface DueRow {
  timer_id: string;
  client_id: string;
  business_name: string;
  contact_name: string;
  phone: string;
  stage: StageKey;
  kind: TimerKind;
  due_on: string;
  note: string;
  scheduled_call_at: Date | null;
  channel: string | null;
}

/**
 * One digest per user per local day, sent once their local clock reaches `digest_hour`.
 * The (user, day) row is claimed BEFORE sending inside the same transaction: two overlapping runs
 * cannot both send, and a failed send rolls the claim back so the next hourly run retries.
 */
export async function runReminders(args: {
  db: DbAccess;
  now: Date;
  appUrl: string;
  send: DigestSender;
  /** An extra rule on who may receive email, on top of `app_users.active` (which every job already requires). Default: everyone. */
  allowed?: (loginEmail: string) => boolean;
}): Promise<ReminderSummary> {
  const users = await args.db.withSystem(
    async (q) =>
      (
        await q.query<UserRow>(
          "select id, email, notify_email, timezone, digest_hour from app_users where digest_enabled and active order by created_at",
        )
      ).rows,
  );
  const summary: ReminderSummary = { users: users.length, sent: 0, skipped: 0, failed: 0 };

  for (const user of users) {
    if (args.allowed && !args.allowed(user.email)) {
      summary.skipped += 1;
      continue;
    }
    if (localHour(user.timezone, args.now) < user.digest_hour) {
      summary.skipped += 1;
      continue;
    }
    const today = todayIn(user.timezone, args.now);
    try {
      const sent = await args.db.withSystem(async (q) => {
        const claim = await q.query(
          "insert into reminders_sent (user_id, kind, for_date, ref) values ($1, 'digest', $2, '') on conflict do nothing",
          [user.id, today],
        );
        if (claim.rowCount === 0) return false;
        const due = await loadDueTimers(q, user.id, today, user.timezone);
        const digest = buildDigest(due, today, args.appUrl);
        if (!digest) throw new NothingDue();
        const providerId = await args.send(user.notify_email ?? user.email, digest);
        await q.query(
          "update reminders_sent set provider_id = $3 where user_id = $1 and kind = 'digest' and for_date = $2 and ref = ''",
          [user.id, today, providerId],
        );
        return true;
      });
      if (sent) summary.sent += 1;
      else summary.skipped += 1;
    } catch (e) {
      if (e instanceof NothingDue) summary.skipped += 1;
      else {
        summary.failed += 1;
        console.error(
          `reminder digest failed for user ${user.id}:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }
  return summary;
}

async function loadDueTimers(
  q: Db,
  userId: string,
  today: string,
  timezone: string,
): Promise<DueTimer[]> {
  const { rows } = await q.query<DueRow>(
    `select t.id as timer_id, t.client_id, c.business_name, c.contact_name, c.phone, c.stage,
            t.kind, t.due_on, t.note, c.scheduled_call_at, t.channel
       from timers t join clients c on c.id = t.client_id
      where t.user_id = $1 and t.done_at is null and t.due_on <= $2::date
        and c.contact_status <> 'dnc'
        and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)`,
    [userId, today],
  );
  return rows.map((r) => ({
    timerId: r.timer_id,
    clientId: r.client_id,
    businessName: r.business_name,
    contactName: r.contact_name,
    phone: r.phone,
    stage: r.stage,
    kind: r.kind,
    dueOn: r.due_on,
    note:
      r.kind === "scheduled_call" && r.scheduled_call_at
        ? `${r.channel === "text" ? "Text" : r.channel === "email" ? "Email" : "Call"} at ${localTime(timezone, r.scheduled_call_at)}`
        : r.note,
  }));
}

/** Sends the digest right now so Isaac can see what it looks like and prove Resend works. Never claims a send it didn't make. */
export async function sendTestDigest(args: {
  db: DbAccess;
  userId: string;
  now: Date;
  appUrl: string;
  send: DigestSender;
}): Promise<{ to: string; usedSample: boolean; count: number }> {
  const user = await args.db.withSystem(async (q) => {
    const { rows } = await q.query<UserRow>(
      "select id, email, notify_email, timezone, digest_hour from app_users where id = $1",
      [args.userId],
    );
    return rows[0];
  });
  if (!user) throw new Error("user not found");
  const today = todayIn(user.timezone, args.now);
  const real = await args.db.withSystem((q) => loadDueTimers(q, user.id, today, user.timezone));
  const usedSample = real.length === 0;
  const timers: DueTimer[] = usedSample
    ? [
        {
          timerId: "sample",
          clientId: "sample",
          businessName: "Sample Pizza (a preview: nothing is due)",
          contactName: "Mike",
          phone: "5551234567",
          stage: "interested",
          kind: "follow_up",
          dueOn: today,
          note: "Wants 50k. Call back after tax return.",
        },
      ]
    : real;
  const digest = buildDigest(timers, today, args.appUrl);
  if (!digest) throw new Error("digest was empty");
  const to = user.notify_email ?? user.email;
  await args.send(to, { ...digest, subject: `[Test] ${digest.subject}` });
  return { to, usedSample, count: timers.length };
}

/** Thrown inside the transaction to roll back the claim when there is nothing to send. */
class NothingDue extends Error {}

export interface CallReminderSummary {
  sent: number;
  failed: number;
}

interface CallRow {
  user_id: string;
  client_id: string;
  business_name: string;
  contact_name: string;
  phone: string;
  scheduled_call_at: Date;
  channel: "call" | "text" | "email" | null;
  timezone: string;
  login_email: string;
  to_email: string;
  wanted_amount_cents: number | null;
  last_call_note: string | null;
}

/** How far ahead the hourly job looks. 90 minutes means a 3:30 call is caught by the 2:00 run. */
export const CALL_REMINDER_WINDOW_MIN = 90;

/**
 * Emails a heads-up for every booked call starting within the next 90 minutes, once per booking.
 * Claim-then-send like the digest; rebooking a call changes the claim key, so the new time gets its own email.
 */
export async function runCallReminders(args: {
  db: DbAccess;
  now: Date;
  appUrl: string;
  send: DigestSender;
  /** Who may still receive email (see runReminders). Default: everyone. */
  allowed?: (loginEmail: string) => boolean;
}): Promise<CallReminderSummary> {
  const due = await args.db.withSystem(
    async (q) =>
      (
        await q.query<CallRow>(
          `select c.user_id, c.id as client_id, c.business_name, c.contact_name, c.phone, c.scheduled_call_at,
                (select t.channel from timers t where t.client_id = c.id and t.kind = 'scheduled_call' and t.done_at is null
                  order by t.created_at desc limit 1) as channel,
                u.timezone, u.email as login_email, coalesce(u.notify_email, u.email) as to_email,
                (select k.wanted_amount_cents from client_asks k where k.client_id = c.id order by k.created_at desc limit 1) as wanted_amount_cents,
                (select a.body from activities a where a.client_id = c.id and a.kind = 'call' and a.body <> '' order by a.occurred_at desc limit 1) as last_call_note
           from clients c join app_users u on u.id = c.user_id
          where u.digest_enabled and u.active and c.scheduled_call_at > $1
            and c.scheduled_call_at <= $1::timestamptz + make_interval(mins => $2)
            and c.contact_status <> 'dnc'
            and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)`,
          [args.now, CALL_REMINDER_WINDOW_MIN],
        )
      ).rows,
  );
  const summary: CallReminderSummary = { sent: 0, failed: 0 };
  for (const c of due) {
    if (args.allowed && !args.allowed(c.login_email)) continue;
    const ref = `${c.client_id}@${c.scheduled_call_at.toISOString()}`;
    try {
      const sent = await args.db.withSystem(async (q) => {
        const claim = await q.query(
          "insert into reminders_sent (user_id, kind, for_date, ref) values ($1, 'call', $2, $3) on conflict do nothing",
          [c.user_id, todayIn(c.timezone, c.scheduled_call_at), ref],
        );
        if (claim.rowCount === 0) return false;
        const msg = buildCallReminder(
          {
            clientId: c.client_id,
            businessName: c.business_name,
            contactName: c.contact_name,
            phone: c.phone,
            callTime: localTime(c.timezone, c.scheduled_call_at),
            channel: c.channel,
            wantedAmount: c.wanted_amount_cents ? formatMoneyCompact(c.wanted_amount_cents) : null,
            lastCallNote: c.last_call_note,
          },
          args.appUrl,
        );
        const providerId = await args.send(c.to_email, msg);
        await q.query(
          "update reminders_sent set provider_id = $4 where user_id = $1 and kind = 'call' and for_date = $2 and ref = $3",
          [c.user_id, todayIn(c.timezone, c.scheduled_call_at), ref, providerId],
        );
        return true;
      });
      if (sent) summary.sent += 1;
    } catch (e) {
      summary.failed += 1;
      console.error(
        `call reminder failed for client ${c.client_id}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return summary;
}
