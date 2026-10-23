import { db as defaultDb, type DbAccess } from "../db";
import { env } from "../env";

/**
 * Dead-man's switch for the hourly scheduler. The cron route calls `recordHeartbeat` after every run that
 * completes (even when nothing needed sending); the layout and Settings ask `reminderStatus` whether it has
 * gone quiet. System-only: `job_runs` has no grants for the browser-facing role (migration 0003).
 */

export const REMINDER_JOB = "reminders";
/** The scheduler is hourly; three missed hours is a problem, not a blip. */
export const STALE_AFTER_HOURS = 3;
const HOUR_MS = 3_600_000;

export async function recordHeartbeat(
  name: string = REMINDER_JOB,
  opts: { db?: DbAccess; now?: Date } = {},
): Promise<void> {
  const access = opts.db ?? defaultDb;
  await access.withSystem((q) =>
    q.query(
      `insert into job_runs (name, last_run_at) values ($1, $2)
       on conflict (name) do update set last_run_at = excluded.last_run_at`,
      [name, (opts.now ?? new Date()).toISOString()],
    ),
  );
}

export interface ReminderStatus {
  /** Resend and the scheduler secret are both set, so the job is supposed to be running. */
  configured: boolean;
  lastRunAt: string | null;
  /** Whole hours since the last run; null when it never ran. */
  hoursSince: number | null;
  /** True when the banner should show. */
  stale: boolean;
  neverRan: boolean;
}

export interface StatusInput {
  configured: boolean;
  lastRunAt: Date | null;
  accountCreatedAt: Date | null;
  now: Date;
}

/**
 * Pure. Stale = configured and (last run older than 3 hours, or never ran and the account is more than
 * a day old: a brand-new account has not had its first hourly call yet).
 */
export function evaluateReminderStatus(i: StatusInput): ReminderStatus {
  if (!i.configured) {
    return { configured: false, lastRunAt: null, hoursSince: null, stale: false, neverRan: false };
  }
  if (i.lastRunAt === null) {
    const accountAgeMs =
      i.accountCreatedAt === null ? 0 : i.now.getTime() - i.accountCreatedAt.getTime();
    return {
      configured: true,
      lastRunAt: null,
      hoursSince: null,
      stale: accountAgeMs > 24 * HOUR_MS,
      neverRan: true,
    };
  }
  const ageMs = Math.max(0, i.now.getTime() - i.lastRunAt.getTime());
  return {
    configured: true,
    lastRunAt: i.lastRunAt.toISOString(),
    hoursSince: Math.floor(ageMs / HOUR_MS),
    stale: ageMs > STALE_AFTER_HOURS * HOUR_MS,
    neverRan: false,
  };
}

/** Reads the heartbeat for one user's banner. Settings can show the same status. */
export async function reminderStatus(
  userId: string,
  opts: { db?: DbAccess; now?: Date; configured?: boolean } = {},
): Promise<ReminderStatus> {
  const configured =
    opts.configured ??
    (() => {
      const e = env();
      return Boolean(e.RESEND_API_KEY && e.CRON_SECRET);
    })();
  const now = opts.now ?? new Date();
  // Nothing to look up when the job is not meant to be running (local dev, before the keys exist).
  if (!configured)
    return evaluateReminderStatus({ configured, lastRunAt: null, accountCreatedAt: null, now });
  const access = opts.db ?? defaultDb;
  const { lastRunAt, accountCreatedAt } = await access.withSystem(async (q) => {
    const run = await q.query<{ last_run_at: Date }>(
      "select last_run_at from job_runs where name = $1",
      [REMINDER_JOB],
    );
    const acct = await q.query<{ created_at: Date }>(
      "select created_at from app_users where id = $1",
      [userId],
    );
    return {
      lastRunAt: run.rows[0]?.last_run_at ?? null,
      accountCreatedAt: acct.rows[0]?.created_at ?? null,
    };
  });
  return evaluateReminderStatus({ configured, lastRunAt, accountCreatedAt, now });
}
