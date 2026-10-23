import { db } from "../db";

export interface AppUser {
  id: string;
  email: string;
  name: string;
  timezone: string;
}

/** Login runs before any user exists, so it uses the owner connection. */
export async function upsertLoginUser(email: string, name: string): Promise<AppUser> {
  return db.withSystem(async (q) => {
    const { rows } = await q.query<AppUser>(
      `insert into app_users (email, name) values ($1, $2)
       on conflict (email) do update set name = case when app_users.name = '' then excluded.name else app_users.name end
       returning id, email, name, timezone`,
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
