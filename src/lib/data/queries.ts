import type { Db } from "../db";
import { todayIn } from "../mca/dates";
import { normalizeUS } from "../mca/phone";
import type { ContactStatus } from "../mca/contact";
import type { StageKey } from "../mca/stages";
import type { ClientBringIn, ClientCard, ClientDetail, UserContext } from "./types";
import { NAME_KEY_SQL, nameKey } from "./nameKey";

export async function userContext(q: Db, now: Date = new Date()): Promise<UserContext> {
  const { rows } = await q.query<{ timezone: string }>(
    "select timezone from app_users where id = app.current_user_id()",
  );
  const timezone = rows[0]?.timezone ?? "UTC";
  return { timezone, today: todayIn(timezone, now) };
}

const json = async <T>(q: Db, sql: string, params: unknown[] = []): Promise<T[]> =>
  (await q.query<{ j: T }>(sql, params)).rows.map((r) => r.j);

/** Every client, soonest follow-up first. One query feeds the lists. */
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
  const stips = await json(
    q,
    "select to_jsonb(s) as j from stips s where s.client_id = $1 order by s.required desc, s.kind, s.period nulls first",
    [id],
  );
  const timers = await json(
    q,
    "select to_jsonb(t) as j from timers t where t.client_id = $1 and t.done_at is null order by t.due_on",
    [id],
  );
  // The hand-off and what leads up to it: not on the client_cards view, so read here for this page only.
  const bringIn = (
    await json<ClientBringIn>(
      q,
      `select to_jsonb(x) as j from (
         select c.brought_in_at, c.brought_in_by, c.reply_waiting_since,
                coalesce((select btrim(u.name) from app_users u where u.id = c.brought_in_by), '') as brought_in_by_name,
                coalesce((select btrim(u.name) from app_users u where u.id = c.user_id), '') as owner_name,
                (select b.name from enrollments e join buckets b on b.id = e.bucket_id
                  where e.client_id = c.id and e.stopped_at is null order by e.entered_at desc limit 1) as bucket_name,
                (select max(a.occurred_at) from activities a
                  where a.client_id = c.id and a.kind = 'email' and a.body like 'Merchant replied%') as replied_at
           from clients c where c.id = $1) x`,
      [id],
    )
  )[0] ?? {
    brought_in_at: null,
    brought_in_by: null,
    brought_in_by_name: "",
    owner_name: "",
    bucket_name: null,
    replied_at: null,
    reply_waiting_since: null,
  };
  return { card, activities, stips, timers, bringIn } as ClientDetail;
}

/** Clients with at least one open timer due today or earlier — the number on the Today tab. */
export async function dueCount(q: Db, today: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    // A do-not-contact merchant is never a call to make, whatever their timer says (Today skips them too).
    `select count(distinct t.client_id)::int as n
       from timers t join clients c on c.id = t.client_id
      where t.done_at is null and t.due_on <= $1::date and c.contact_status <> 'dnc'`,
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
  reason: "same phone" | "same email" | "same business name";
  /** The matched merchant's phone as stored ("" when none) — name matches only count when one side has no phone. */
  phone: string;
  /** Whose merchant it is (the rep's name), so two reps don't work the same lead by accident. */
  owner_name: string;
  /** The bucket it sits in right now, or null when it is in none (then the stage says where it is). */
  bucket_name: string | null;
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
/**
 * The merchants (visible to the caller) a new lead would duplicate: the same phone (main or second), the same email
 * (main or second, any case), or the same business name. Phone and email matches come first.
 */
export async function findDuplicates(
  q: Db,
  input: { phone?: string; email?: string; businessName?: string; excludeId?: string },
): Promise<DuplicateMatch[]> {
  const e164 = input.phone ? normalizeUS(input.phone) : null;
  const digits = e164 ? e164.slice(2) : null;
  const name = nameKey(input.businessName ?? "");
  const email = (input.email ?? "").trim().toLowerCase();
  if (!digits && !name && !email) return [];
  const { rows } = await q.query<{
    id: string;
    business_name: string;
    contact_name: string;
    stage: StageKey;
    phone: string;
    by_phone: boolean;
    by_email: boolean;
    trashed: boolean;
    owner_name: string;
    bucket_name: string | null;
  }>(
    `select id, business_name, contact_name, stage, phone,
            ($1::text is not null and (right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1
                                       or right(regexp_replace(coalesce(phone2, ''), '[^0-9]', '', 'g'), 10) = $1)) as by_phone,
            ($4 <> '' and (lower(btrim(email)) = $4 or lower(btrim(coalesce(email2, ''))) = $4)) as by_email,
            exists (select 1 from trashed_clients t where t.client_id = clients.id) as trashed,
            coalesce((select u.name from app_users u where u.id = clients.user_id), '') as owner_name,
            (select b.name from enrollments e join buckets b on b.id = e.bucket_id
              where e.client_id = clients.id and e.stopped_at is null order by e.entered_at desc limit 1) as bucket_name
       from clients
      where (contact_status <> 'ok' or not exists (select 1 from trashed_clients t where t.client_id = clients.id))
        and ($3::uuid is null or id <> $3::uuid)
        and (($1::text is not null and (right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1
                                         or right(regexp_replace(coalesce(phone2, ''), '[^0-9]', '', 'g'), 10) = $1))
         or ($4 <> '' and (lower(btrim(email)) = $4 or lower(btrim(coalesce(email2, ''))) = $4))
         or ($2 <> '' and ${NAME_KEY_SQL("business_name")} = $2))
      order by by_phone desc, by_email desc, business_name
      limit 5`,
    [digits, name, input.excludeId ?? null, email],
  );
  return rows.map((r) => ({
    id: r.id,
    business_name: r.business_name,
    contact_name: r.contact_name,
    stage: r.stage,
    reason: r.by_phone ? "same phone" : r.by_email ? "same email" : "same business name",
    phone: r.phone,
    trashed: r.trashed,
    owner_name: r.owner_name,
    bucket_name: r.bucket_name,
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
