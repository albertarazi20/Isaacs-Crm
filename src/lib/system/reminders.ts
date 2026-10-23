import type { Db, DbAccess } from "../db";
import { todayIn } from "../mca/dates";
import { buildDigest, type DueTimer } from "../mca/digest";
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
}): Promise<ReminderSummary> {
  const users = await args.db.withSystem(
    async (q) =>
      (
        await q.query<UserRow>(
          "select id, email, notify_email, timezone, digest_hour from app_users where digest_enabled order by created_at",
        )
      ).rows,
  );
  const summary: ReminderSummary = { users: users.length, sent: 0, skipped: 0, failed: 0 };

  for (const user of users) {
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
            t.kind, t.due_on, t.note, c.scheduled_call_at
       from timers t join clients c on c.id = t.client_id
      where t.user_id = $1 and t.done_at is null and t.due_on <= $2::date`,
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
        ? `Call at ${localTime(timezone, r.scheduled_call_at)}`
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
          businessName: "Sample Pizza (nothing is due — this is a preview)",
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
