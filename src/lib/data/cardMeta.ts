import type { Db } from "../db";

/** What the Merchants list shows beside a card that the card itself does not carry. Read only. */
export interface CardMeta {
  /** The bucket the merchant sits in right now, or null when it is in none. */
  bucket_id: string | null;
  bucket_name: string | null;
  owner_id: string;
  /** The rep whose merchant it is. */
  owner_name: string;
  /** When the rep handed the merchant off ("brought in"), or null while it is still being worked. */
  brought_in_at: string | null;
  /**
   * The last time the merchant themself did something: wrote back, opened their link or application, sent a
   * document, signed. Null when they never have. What "Most active" sorts by and the "Active" mark shows.
   */
  active_at: string | null;
}

/** Bucket, owner and hand-off for every merchant the caller can see, by client id. Trash is left out. */
export async function listCardMeta(q: Db): Promise<Record<string, CardMeta>> {
  const { rows } = await q.query<
    Omit<CardMeta, "brought_in_at" | "active_at"> & {
      id: string;
      brought_in_at: string | Date | null;
      active_at: string | Date | null;
    }
  >(
    `select c.id, c.brought_in_at, c.user_id as owner_id,
            coalesce((select u.name from app_users u where u.id = c.user_id), '') as owner_name,
            e.bucket_id, e.bucket_name,
            greatest(
              (select max(ie.received_at) from inbound_emails ie where ie.client_id = c.id),
              (select max(a.occurred_at) from activities a
                where a.client_id = c.id and a.kind = 'email' and a.body like 'Merchant replied%'),
              (select max(lo.opened_at) from link_opens lo where lo.client_id = c.id),
              (select max(d.created_at) from documents d
                where d.client_id = c.id and d.deleted_at is null and d.source in ('upload_link', 'email')),
              (select max(ap.signed_at) from applications ap where ap.client_id = c.id)
            ) as active_at
       from clients c
       left join lateral (
         select b.id as bucket_id, b.name as bucket_name
           from enrollments en join buckets b on b.id = en.bucket_id
          where en.client_id = c.id and en.stopped_at is null
          order by en.entered_at desc limit 1) e on true
      where not exists (select 1 from trashed_clients t where t.client_id = c.id)`,
  );
  // timestamps arrive from pg as Date objects; the list sorts and compares them as ISO strings
  const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
  const out: Record<string, CardMeta> = {};
  for (const { id, ...meta } of rows)
    out[id] = { ...meta, brought_in_at: iso(meta.brought_in_at), active_at: iso(meta.active_at) };
  return out;
}
