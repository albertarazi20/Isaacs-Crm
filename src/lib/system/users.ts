import { db } from "../db";
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
export async function loginUser(email: string, name: string): Promise<AppUser | null> {
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
export async function bootstrapFirstManager(email: string, name: string): Promise<AppUser | null> {
  return db.withSystem(async (q) => {
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
  role: Role = "manager",
): Promise<AppUser> {
  return db.withSystem(async (q) => {
    const { rows } = await q.query<AppUser>(
      `insert into app_users (email, name, role) values ($1, $2, $3)
       on conflict (email) do update set name = case when app_users.name = '' then excluded.name else app_users.name end
       returning id, email, name, timezone, session_epoch, role, active`,
      [email.toLowerCase(), name, role],
    );
    const user = rows[0];
    if (!user) throw new Error("dev login upsert returned no row");
    return user;
  });
}

export async function userExists(id: string): Promise<boolean> {
  return db.withSystem(
    async (q) => (await q.query("select 1 from app_users where id = $1", [id])).rowCount === 1,
  );
}

/** The epoch a session must carry, or null when the user no longer exists. */
export async function currentSessionEpoch(userId: string): Promise<number | null> {
  return db.withSystem(async (q) => {
    const { rows } = await q.query<{ session_epoch: number }>(
      "select session_epoch from app_users where id = $1 and active",
      [userId],
    );
    return rows[0]?.session_epoch ?? null;
  });
}

/** Invalidates every session this user has, on every device. */
export async function bumpSessionEpoch(userId: string): Promise<void> {
  await db.withSystem((q) =>
    q.query("update app_users set session_epoch = session_epoch + 1 where id = $1", [userId]),
  );
}
