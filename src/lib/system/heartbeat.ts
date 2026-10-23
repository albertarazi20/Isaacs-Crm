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

/** The three settings the hourly job needs. One definition, used by the route, the banner and Settings. */
export const REMINDER_ENV = ["RESEND_API_KEY", "RESEND_FROM", "CRON_SECRET"] as const;

export function missingReminderEnv(
  e: Partial<Record<(typeof REMINDER_ENV)[number], string | undefined>>,
): string[] {
  return REMINDER_ENV.filter((k) => !e[k]);
}

export interface ReminderStatus {
  /** Resend, the sender address and the scheduler secret are all set, so the job is supposed to be running. */
  configured: boolean;
  /** Which settings are missing (empty when configured). In production, missing ones raise the banner. */
  missing: string[];
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
  /** Settings that are not set. With `production`, a day-old account with some missing gets the banner. */
  missing?: string[];
  production?: boolean;
}

/**
 * Pure. Stale = configured and (last run older than 3 hours, or never ran and the account is more than
 * a day old: a brand-new account has not had its first hourly call yet).
 */
export function evaluateReminderStatus(i: StatusInput): ReminderStatus {
  const missing = i.missing ?? [];
  if (!i.configured) {
    // Locally nothing is set and nothing is expected. In production a missing setting means reminders never go out,
    // and nothing else would say so: after the account's first day, raise the banner and name the setting.
    const accountAgeMs =
      i.accountCreatedAt === null ? 0 : i.now.getTime() - i.accountCreatedAt.getTime();
    return {
      configured: false,
      missing,
      lastRunAt: null,
      hoursSince: null,
      stale: Boolean(i.production) && missing.length > 0 && accountAgeMs > 24 * HOUR_MS,
      neverRan: false,
    };
  }
  if (i.lastRunAt === null) {
    const accountAgeMs =
      i.accountCreatedAt === null ? 0 : i.now.getTime() - i.accountCreatedAt.getTime();
    return {
      configured: true,
      missing: [],
      lastRunAt: null,
      hoursSince: null,
      stale: accountAgeMs > 24 * HOUR_MS,
      neverRan: true,
    };
  }
  const ageMs = Math.max(0, i.now.getTime() - i.lastRunAt.getTime());
  return {
    configured: true,
    missing: [],
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
  const missing = opts.configured === undefined ? missingReminderEnv(env()) : [];
  const configured = opts.configured ?? missing.length === 0;
  const production = process.env.NODE_ENV === "production";
  const now = opts.now ?? new Date();
  const access = opts.db ?? defaultDb;
  // Nothing to look up when the job is not meant to be running (local dev, before the keys exist) — except in
  // production, where how old the account is decides whether a missing setting is worth a banner yet.
  if (!configured) {
    if (!production || missing.length === 0)
      return evaluateReminderStatus({
        configured,
        missing,
        lastRunAt: null,
        accountCreatedAt: null,
        now,
      });
    const created = await access.withSystem(async (q) => {
      const acct = await q.query<{ created_at: Date }>(
        "select created_at from app_users where id = $1",
        [userId],
      );
      return acct.rows[0]?.created_at ?? null;
    });
    return evaluateReminderStatus({
      configured,
      missing,
      production,
      lastRunAt: null,
      accountCreatedAt: created,
      now,
    });
  }
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
