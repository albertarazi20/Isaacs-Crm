import type { DbAccess } from "../db";

/**
 * A merchant opened their upload link or their application (sent by the page after a real browser showed it for a
 * few seconds; see db/migrations/0547_link_opens.sql). The token is the key: an unknown token records nothing, and the
 * caller learns nothing either way. One row per merchant and link per half hour, one timeline line per day, nothing for
 * a merchant in the trash or already handed off.
 */
export type LinkKind = "upload" | "apply";

const LINE: Record<LinkKind, string> = {
  upload: "Opened the upload link",
  apply: "Opened the application",
};

export async function recordLinkOpen(
  db: DbAccess,
  kind: LinkKind,
  token: string,
): Promise<boolean> {
  const shape = kind === "apply" ? /^[0-9a-f]{40,80}$/ : /^[A-Za-z0-9]{20,80}$/;
  if (!shape.test(token)) return false;
  return db.withSystem(async (q) => {
    const { rows } = await q.query<{ id: string; user_id: string }>(
      kind === "apply"
        ? `select c.id, c.user_id from clients c where c.application_token = $1`
        : `select c.id, c.user_id from clients c
            where c.upload_token = $1
               or c.id = (select s.client_id from upload_sessions s where s.token = $1 and s.expires_at > now())`,
      [token],
    );
    const c = rows[0];
    if (!c) return false;
    const usable = await q.query(
      `select 1 from clients c where c.id = $1 and c.brought_in_at is null
          and not exists (select 1 from trashed_clients t where t.client_id = c.id)`,
      [c.id],
    );
    if (usable.rowCount === 0) return false;
    const added = await q.query(
      `insert into link_opens (client_id, kind)
       select $1, $2
        where not exists (select 1 from link_opens o
                           where o.client_id = $1 and o.kind = $2 and o.opened_at > now() - interval '30 minutes')`,
      [c.id, kind],
    );
    if ((added.rowCount ?? 0) > 0)
      await q.query(
        `insert into activities (user_id, client_id, kind, body)
         select $1, $2, 'system', $3
          where not exists (select 1 from activities a
                             where a.client_id = $2 and a.kind = 'system' and a.body = $3
                               and a.occurred_at > now() - interval '20 hours')`,
        [c.user_id, c.id, LINE[kind]],
      );
    return (added.rowCount ?? 0) > 0;
  });
}
