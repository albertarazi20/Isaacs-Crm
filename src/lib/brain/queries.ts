import type { Db } from "../db";
import type { PrepKind } from "./briefs";

export interface PrepRow {
  id: string;
  clientId: string | null;
  businessName: string | null;
  kind: PrepKind;
  summary: string;
  actions: number;
  readyAt: string;
}

/**
 * What the assistant has prepared for the signed-in rep and they have not opened yet, newest first. Row security
 * shows a rep only their own; a preparation older than three days is left out (the merchant has moved on).
 */
export async function listPreps(q: Db, limit = 12): Promise<PrepRow[]> {
  const { rows } = await q.query<{
    id: string;
    client_id: string | null;
    business_name: string | null;
    kind: PrepKind;
    summary: string;
    actions: number;
    ready_at: string;
  }>(
    `select p.id, p.client_id, c.business_name, p.kind, p.summary, p.actions,
            to_char(p.ready_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ready_at
       from brain_preps p left join clients c on c.id = p.client_id
      where p.status = 'ready' and p.thread_id is not null and p.seen_at is null
        and p.ready_at > now() - interval '3 days'
      order by (p.kind = 'plan') desc, p.ready_at desc
      limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    clientId: r.client_id,
    businessName: r.business_name,
    kind: r.kind,
    summary: r.summary,
    actions: r.actions,
    readyAt: r.ready_at,
  }));
}

/** The conversation behind a preparation, marked read. Null when it is not the signed-in rep's or not ready. */
export async function openPrep(q: Db, id: string): Promise<string | null> {
  const { rows } = await q.query<{ thread_id: string }>(
    `update brain_preps set seen_at = coalesce(seen_at, now())
      where id = $1 and status = 'ready' and thread_id is not null
      returning thread_id`,
    [id],
  );
  return rows[0]?.thread_id ?? null;
}

/**
 * True when what a preparation was made for may have moved on, so its buttons must not be trusted: it is more than a day
 * old, or the merchant has been handed off, asked not to be contacted, trashed, or has had any activity (a call, a note,
 * an email either way) since it was made. The server checks each button again on the click; this is the warning.
 */
export async function prepIsStale(q: Db, id: string): Promise<boolean> {
  const { rows } = await q.query<{ stale: boolean }>(
    `select (p.ready_at is null or p.ready_at < now() - interval '1 day'
             or (p.client_id is not null and (
                  c.id is null or c.brought_in_at is not null or c.contact_status = 'dnc'
                  or exists (select 1 from trashed_clients tc where tc.client_id = c.id)
                  or exists (select 1 from activities a where a.client_id = c.id and a.occurred_at > p.ready_at)))
            ) as stale
       from brain_preps p left join clients c on c.id = p.client_id
      where p.id = $1`,
    [id],
  );
  return rows[0]?.stale ?? true;
}
