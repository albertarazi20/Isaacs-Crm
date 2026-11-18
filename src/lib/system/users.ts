import { db as defaultDb, type DbAccess } from "../db";
import { isAllowedEmail } from "../auth/google";
import { env } from "../env";
import type { Role } from "../auth/roles";

export interface AppUser {
  id: string;
  email: string;
  name: string;
  timezone: string;
  session_epoch: number;
  role: Role;
  active: boolean;
}

/**
 * Sign-in only admits an account a manager already created: an unknown or disabled address gets null and the
 * login page says so. Runs before a session exists, so it uses the owner connection. Fills in the Google name
 * the first time and stamps last_login_at.
 */
export async function loginUser(
  email: string,
  name: string,
  db: DbAccess = defaultDb,
): Promise<AppUser | null> {
  return db.withSystem(async (q) => {
    const { rows } = await q.query<AppUser>(
      `update app_users
          set name = case when name = '' then $2 else name end,
              last_login_at = now()
        where email = $1 and active
        returning id, email, name, timezone, session_epoch, role, active`,
      [email.toLowerCase(), name],
    );
    return rows[0] ?? null;
  });
}

/**
 * The very first account. Only when the table is empty (a fresh install): whoever signs in first becomes the
 * manager and adds everyone else. After that this is a no-op and login goes through loginUser.
 */
export async function bootstrapFirstManager(
  email: string,
  name: string,
  db: DbAccess = defaultDb,
): Promise<AppUser | null> {
  // Fail closed: a production install with no ALLOWED_EMAILS must not hand the first stranger with a Google account
  // the manager role. The address has to be on the list there; development keeps the open first sign-in.
  if (process.env.NODE_ENV === "production" && !isAllowedEmail(email, env().ALLOWED_EMAILS))
    return null;
  return db.withSystem(async (q) => {
    // Two first sign-ins in the same instant would both pass "not exists" under read committed. The lock makes the
    // second wait, and its insert then runs on a fresh snapshot that sees the first manager.
    await q.query("select pg_advisory_xact_lock(727275)");
    const { rows } = await q.query<AppUser>(
      `insert into app_users (email, name, role)
       select $1, $2, 'manager' where not exists (select 1 from app_users)
       returning id, email, name, timezone, session_epoch, role, active`,
      [email.toLowerCase(), name],
    );
    return rows[0] ?? null;
  });
}

/** Local development only: the dev login may create the account it signs in as. */
export async function upsertDevUser(
  email: string,
  name: string,
  role: Role | null = null,
  db: DbAccess = defaultDb,
): Promise<AppUser> {
  return db.withSystem(async (q) => {
    const { rows } = await q.query<AppUser>(
      `insert into app_users (email, name, role) values ($1, $2, coalesce($3, 'manager'))
       on conflict (email) do update set name = case when app_users.name = '' then excluded.name else app_users.name end,
                                         role = coalesce($3, app_users.role), active = true
       returning id, email, name, timezone, session_epoch, role, active`,
      [email.toLowerCase(), name, role],
    );
    const user = rows[0];
    if (!user) throw new Error("dev login upsert returned no row");
    return user;
  });
}

export async function userExists(id: string, db: DbAccess = defaultDb): Promise<boolean> {
  return db.withSystem(
    async (q) => (await q.query("select 1 from app_users where id = $1", [id])).rowCount === 1,
  );
}

/** The epoch a session must carry, or null when the user no longer exists. */
export async function currentSessionEpoch(
  userId: string,
  db: DbAccess = defaultDb,
): Promise<number | null> {
  return db.withSystem(async (q) => {
    const { rows } = await q.query<{ session_epoch: number }>(
      "select session_epoch from app_users where id = $1 and active",
      [userId],
    );
    return rows[0]?.session_epoch ?? null;
  });
}

/** Invalidates every session this user has, on every device. */
export async function bumpSessionEpoch(userId: string, db: DbAccess = defaultDb): Promise<void> {
  await db.withSystem((q) =>
    q.query("update app_users set session_epoch = session_epoch + 1 where id = $1", [userId]),
  );
}

/** Passcode sign-in: this many attempts from one address in the window lock that address for the lock time. */
export const PASSCODE_MAX_ATTEMPTS = 5;
export const PASSCODE_WINDOW_SECONDS = 15 * 60;
export const PASSCODE_LOCK_SECONDS = 15 * 60;
/**
 * The shared bucket for a request with no readable client address (the platform header is always there behind Netlify,
 * so this only happens off-platform or behind a stripped proxy). Every such caller counts here together, so the limit
 * is much higher: five wrong guesses from a stranger must not lock the real manager out, while brute force stays
 * bounded (30 guesses per 15 minutes in all). It cannot equal a real key, which always starts with "ip:".
 */
export const PASSCODE_NO_ADDRESS_KEY = "no-address";
export const PASSCODE_NO_ADDRESS_MAX_ATTEMPTS = 30;

/** The key one request counts under: its client address, or the shared bucket when none can be read. */
export const passcodeKey = (address: string): string =>
  address ? `ip:${address}` : PASSCODE_NO_ADDRESS_KEY;

const passcodeMaxFor = (key: string): number =>
  key === PASSCODE_NO_ADDRESS_KEY ? PASSCODE_NO_ADDRESS_MAX_ATTEMPTS : PASSCODE_MAX_ATTEMPTS;

export interface PasscodeClaim {
  /** false: the address is locked; the passcode must not even be compared */
  allowed: boolean;
  /** seconds until the lock ends, 0 while no lock is in force. true on the attempt that trips the lock */
  retryAfterSeconds: number;
}

/**
 * Counts one passcode attempt for `key` (see passcodeKey: a client address, or the shared no-address bucket) and says whether it may be compared. Counting happens
 * first, in one atomic statement, so parallel guesses cannot all pass a check-then-count gap. The lock is set on the
 * attempt that reaches the limit; that attempt is still compared (a correct one clears the row) but a wrong one is
 * answered with the lockout. Attempts made while locked are refused and never extend the lock. An expired lock or
 * window starts the count again.
 */
export async function claimPasscodeAttempt(
  key: string,
  db: DbAccess = defaultDb,
): Promise<PasscodeClaim> {
  const max = passcodeMaxFor(key);
  return db.withSystem(async (q) => {
    const { rows } = await q.query<{ failures: number; retry_after: number }>(
      `insert into passcode_attempts as p (key, failures, window_start, locked_until)
       values ($1, 1, now(), case when 1 >= $3::int then now() + make_interval(secs => $4::int) end)
       on conflict (key) do update set
         failures = case
           when coalesce(p.locked_until > now(), false) then least(p.failures + 1, 1000)
           when coalesce(p.locked_until <= now(), false) or p.window_start <= now() - make_interval(secs => $2::int) then 1
           else p.failures + 1 end,
         window_start = case
           when coalesce(p.locked_until > now(), false) then p.window_start
           when coalesce(p.locked_until <= now(), false) or p.window_start <= now() - make_interval(secs => $2::int) then now()
           else p.window_start end,
         locked_until = case
           when coalesce(p.locked_until > now(), false) then p.locked_until
           when coalesce(p.locked_until <= now(), false) or p.window_start <= now() - make_interval(secs => $2::int)
             then case when 1 >= $3::int then now() + make_interval(secs => $4::int) end
           when p.failures + 1 >= $3::int then now() + make_interval(secs => $4::int)
           end
       returning failures,
         coalesce(ceil(extract(epoch from (locked_until - now()))), 0)::int as retry_after`,
      [key, PASSCODE_WINDOW_SECONDS, max, PASSCODE_LOCK_SECONDS],
    );
    // Keeps the table to the addresses that tried lately; a day-old, unlocked row counts for nothing.
    await q.query(
      "delete from passcode_attempts where window_start < now() - interval '1 day' and (locked_until is null or locked_until < now())",
    );
    const row = rows[0];
    return {
      allowed: (row?.failures ?? 0) <= max,
      retryAfterSeconds: Math.max(0, row?.retry_after ?? 0),
    };
  });
}

/** A correct passcode: the address starts clean. */
export async function clearPasscodeAttempts(key: string, db: DbAccess = defaultDb): Promise<void> {
  await db.withSystem((q) => q.query("delete from passcode_attempts where key = $1", [key]));
}
