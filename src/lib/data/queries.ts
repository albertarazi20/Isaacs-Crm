import type { Db } from "../db";
import { todayIn } from "../mca/dates";
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
