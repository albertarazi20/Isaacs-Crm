import type { Db } from "../db";

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  last_login_at: string | null;
  gmail_connected: boolean;
  clients: number;
}

export async function listTeam(q: Db): Promise<TeamMember[]> {
  const { rows } = await q.query<TeamMember>(
    `select u.id, u.email, u.name, u.role, u.active, u.last_login_at::text as last_login_at,
            exists (select 1 from mailboxes m where m.user_id = u.id and m.kind = 'gmail' and m.active) as gmail_connected,
            (select count(*)::int from clients c where c.user_id = u.id and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)) as clients
       from app_users u order by u.active desc, u.role, u.name`,
  );
  return rows;
}
