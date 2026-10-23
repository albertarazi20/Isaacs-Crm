import type { Db } from "../db";
import { todayIn } from "../mca/dates";
import { normalizeUS } from "../mca/phone";
import type { ContactStatus } from "../mca/contact";
import type { StageKey } from "../mca/stages";
import type { ClientCard, ClientDetail, UserContext } from "./types";

export async function userContext(q: Db, now: Date = new Date()): Promise<UserContext> {
  const { rows } = await q.query<{ timezone: string }>(
    "select timezone from app_users where id = app.current_user_id()",
  );
  const timezone = rows[0]?.timezone ?? "UTC";
  return { timezone, today: todayIn(timezone, now) };
}

const json = async <T>(q: Db, sql: string, params: unknown[] = []): Promise<T[]> =>
  (await q.query<{ j: T }>(sql, params)).rows.map((r) => r.j);

/** Every client, soonest follow-up first. One query feeds the board, call list, renewals and long game. */
export async function listCards(q: Db): Promise<ClientCard[]> {
  return json<ClientCard>(
    q,
    "select to_jsonb(c) as j from client_cards c order by c.next_due_on nulls last, lower(c.business_name)",
  );
}

export async function getCard(q: Db, id: string): Promise<ClientCard | null> {
  return (
    (
      await json<ClientCard>(q, "select to_jsonb(c) as j from client_cards c where c.id = $1", [id])
    )[0] ?? null
  );
}

export async function getClientDetail(q: Db, id: string): Promise<ClientDetail | null> {
  const card = await getCard(q, id);
  if (!card) return null;
  // One at a time: a pooled connection runs a single query at once (pg 9 drops the queueing).
  const activities = await json(
    q,
    "select to_jsonb(a) as j from activities a where a.client_id = $1 order by a.occurred_at desc, a.id desc limit 300",
    [id],
  );
  const positions = await json(
    q,
    "select to_jsonb(p) as j from positions p where p.client_id = $1 order by p.position_no, p.created_at",
    [id],
  );
  const offers = await json(
    q,
    "select to_jsonb(o) as j from competing_offers o where o.client_id = $1 order by o.offered_on desc, o.created_at desc",
    [id],
  );
  const asks = await json(
    q,
    "select to_jsonb(k) as j from client_asks k where k.client_id = $1 order by k.created_at desc",
    [id],
  );
  const stips = await json(
    q,
    "select to_jsonb(s) as j from stips s where s.client_id = $1 order by s.required desc, s.kind, s.period nulls first",
    [id],
  );
  const fundings = await json(
    q,
    "select to_jsonb(f) as j from fundings f where f.client_id = $1 order by f.funded_on desc, f.created_at desc",
    [id],
  );
  const timers = await json(
    q,
    "select to_jsonb(t) as j from timers t where t.client_id = $1 and t.done_at is null order by t.due_on",
    [id],
  );
  return { card, activities, positions, offers, asks, stips, fundings, timers } as ClientDetail;
}

/** Clients with at least one open timer due today or earlier — the number on the Today tab. */
export async function dueCount(q: Db, today: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    "select count(distinct client_id)::int as n from timers where done_at is null and due_on <= $1::date",
    [today],
  );
  return rows[0]?.n ?? 0;
}

export interface DuplicateMatch {
  id: string;
  business_name: string;
  contact_name: string;
  stage: StageKey;
  /** Why it matched, in words Isaac can check at a glance. */
  reason: "same phone" | "same business name";
  /**
   * In the trash, but marked do-not-contact (or limited). Those stay matchable so a "stop" can't be undone
   * by re-adding the same number as a fresh lead.
   */
  trashed: boolean;
}

/**
 * Clients that look like the one being added: same phone number (however it was typed) or the same
 * business name ignoring case and punctuation. The same merchant comes back under a slightly
 * different name constantly — this is how a second card never quietly appears.
 */
export async function findDuplicates(
  q: Db,
  input: { phone?: string; businessName?: string },
): Promise<DuplicateMatch[]> {
  const e164 = input.phone ? normalizeUS(input.phone) : null;
  const digits = e164 ? e164.slice(2) : null;
  const name = (input.businessName ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (!digits && !name) return [];
  const { rows } = await q.query<{
    id: string;
    business_name: string;
    contact_name: string;
    stage: StageKey;
    by_phone: boolean;
    trashed: boolean;
  }>(
    `select id, business_name, contact_name, stage,
            ($1::text is not null and right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1) as by_phone,
            exists (select 1 from trashed_clients t where t.client_id = clients.id) as trashed
       from clients
      where (contact_status <> 'ok' or not exists (select 1 from trashed_clients t where t.client_id = clients.id))
        and (($1::text is not null and right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1)
         or ($2 <> '' and regexp_replace(lower(business_name), '[^[:alnum:]]+', '', 'g') = $2))
      order by by_phone desc, business_name
      limit 5`,
    [digits, name],
  );
  return rows.map((r) => ({
    id: r.id,
    business_name: r.business_name,
    contact_name: r.contact_name,
    stage: r.stage,
    reason: r.by_phone ? "same phone" : "same business name",
    trashed: r.trashed,
  }));
}

export interface TrashedClient {
  id: string;
  business_name: string;
  contact_name: string;
  phone: string;
  stage: StageKey;
  trashed_at: string;
  /** Anything but "ok": the record is kept for good so the merchant can't be re-added as a fresh lead. */
  contact_status: ContactStatus;
}

/** Newest first. Reads through row-level security like everything else. */
export async function listTrashed(q: Db): Promise<TrashedClient[]> {
  return json<TrashedClient>(
    q,
    `select jsonb_build_object('id', c.id, 'business_name', c.business_name, 'contact_name', c.contact_name,
                              'phone', c.phone, 'stage', c.stage, 'trashed_at', t.trashed_at,
                              'contact_status', c.contact_status) as j
       from trashed_clients t join clients c on c.id = t.client_id
      order by t.trashed_at desc`,
  );
}

/** The sources already in use, most used first. Trash is left out. */
export async function listSources(q: Db): Promise<string[]> {
  const { rows } = await q.query<{ source: string }>(
    `select mode() within group (order by c.source) as source
       from clients c
      where c.source <> '' and c.source <> 'Imported'
        and not exists (select 1 from trashed_clients t where t.client_id = c.id)
      group by lower(btrim(c.source))
      order by count(*) desc, lower(btrim(c.source))
      limit 40`,
  );
  return rows.map((r) => r.source);
}
