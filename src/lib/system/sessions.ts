import { db as defaultDb, type DbAccess } from "../db";
import type { TouchResult } from "../auth/resolve";
import { SESSION_DAYS, SESSION_IDLE_SECONDS, SESSION_ROLL_SECONDS } from "../auth/session";

/**
 * The idle-timeout store (0575): one row per sign-in. Runs on the owner connection because it happens before and
 * around a session, and the table is system-only. Times come from the caller's clock, not the database's, so the
 * sign-in, the check and the tests all agree on what "now" is.
 */

/** Records a new sign-in as just used. */
export async function startSession(
  sid: string,
  userId: string,
  now: Date = new Date(),
  db: DbAccess = defaultDb,
): Promise<void> {
  await db.withSystem((q) =>
    q.query(
      `insert into session_activity (sid, user_id, created_at, last_seen_at) values ($1, $2, $3, $3)`,
      [sid, userId, now],
    ),
  );
}

/**
 * Signing out: deletes this sign-in's row, so a copy of its cookie is refused from now on ("unknown": no record).
 * Scoped to the user as well, so a cookie can only ever end its own person's row. Returns how many rows went.
 */
export async function endSession(
  sid: string,
  userId: string,
  db: DbAccess = defaultDb,
): Promise<number> {
  const { rowCount } = await db.withSystem((q) =>
    q.query(`delete from session_activity where sid = $1 and user_id = $2`, [sid, userId]),
  );
  return rowCount ?? 0;
}

/** "Log out everywhere": deletes every sign-in row this person has, on every device. Returns how many rows went. */
export async function endAllSessions(userId: string, db: DbAccess = defaultDb): Promise<number> {
  const { rowCount } = await db.withSystem((q) =>
    q.query(`delete from session_activity where user_id = $1`, [userId]),
  );
  return rowCount ?? 0;
}

/**
 * One statement: reads when the session was last used and, if that is inside the idle window but at least the roll
 * interval old, moves it to now. A session used again within the roll interval writes nothing. "idle" means the last
 * use is older than the idle window (and stays so: nothing rolls an idle session); "unknown" means no record.
 */
export async function touchSession(
  sid: string,
  userId: string,
  now: Date = new Date(),
  db: DbAccess = defaultDb,
): Promise<TouchResult> {
  const { rows } = await db.withSystem((q) =>
    q.query<{ last_seen_at: Date | null }>(
      `with cur as (
         select last_seen_at from session_activity where sid = $1 and user_id = $2
       ), rolled as (
         update session_activity set last_seen_at = $3
          where sid = $1 and user_id = $2
            and last_seen_at > $3::timestamptz - make_interval(secs => $4::int)
            and last_seen_at <= $3::timestamptz - make_interval(secs => $5::int)
         returning 1
       )
       select (select last_seen_at from cur) as last_seen_at`,
      [sid, userId, now, SESSION_IDLE_SECONDS, SESSION_ROLL_SECONDS],
    ),
  );
  const last = rows[0]?.last_seen_at;
  if (!last) return "unknown";
  return last.getTime() > now.getTime() - SESSION_IDLE_SECONDS * 1000 ? "ok" : "idle";
}

/** Deletes the records of sessions that are past the absolute lifetime anyway (a day of margin). Returns how many. */
export async function sweepSessions(
  now: Date = new Date(),
  db: DbAccess = defaultDb,
): Promise<number> {
  const keepSeconds = (SESSION_DAYS + 1) * 86_400;
  const { rowCount } = await db.withSystem((q) =>
    q.query(
      `delete from session_activity where last_seen_at < $1::timestamptz - make_interval(secs => $2::int)`,
      [now, keepSeconds],
    ),
  );
  return rowCount ?? 0;
}
