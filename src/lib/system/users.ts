import { db } from "../db";

export interface AppUser {
  id: string;
  email: string;
  name: string;
  timezone: string;
  session_epoch: number;
}

/** Login runs before any user exists, so it uses the owner connection. */
export async function upsertLoginUser(email: string, name: string): Promise<AppUser> {
  return db.withSystem(async (q) => {
    const { rows } = await q.query<AppUser>(
      `insert into app_users (email, name) values ($1, $2)
       on conflict (email) do update set name = case when app_users.name = '' then excluded.name else app_users.name end
       returning id, email, name, timezone, session_epoch`,
      [email.toLowerCase(), name],
    );
    const user = rows[0];
    if (!user) throw new Error("login upsert returned no row");
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
      "select session_epoch from app_users where id = $1",
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
