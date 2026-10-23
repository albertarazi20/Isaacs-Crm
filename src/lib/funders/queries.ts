import type { Db } from "../db";
import { buildScoreboard, type OfferStat, type ScoreRow, type SubmissionStat } from "./scoreboard";
import type { ClientFundersData, FunderRow, SubmissionRow } from "./types";

const json = async <T>(q: Db, sql: string, params: unknown[] = []): Promise<T[]> =>
  (await q.query<{ j: T }>(sql, params)).rows.map((r) => r.j);

/** Active funders first, then A–Z. */
export async function listFunders(q: Db): Promise<FunderRow[]> {
  return json<FunderRow>(
    q,
    "select to_jsonb(f) as j from funders f order by f.active desc, lower(f.name)",
  );
}

/** Every submission on one merchant, newest first, each with its offers and its open chase date. */
export async function listClientSubmissions(q: Db, clientId: string): Promise<SubmissionRow[]> {
  return json<SubmissionRow>(
    q,
    `select to_jsonb(s) || jsonb_build_object(
              'funder_name', f.name,
              'responded_on', (s.responded_at at time zone u.timezone)::date,
              'chase_due_on', (select t.due_on from timers t
                                where t.submission_id = s.id and t.kind = 'chase' and t.done_at is null),
              'offers', coalesce((select jsonb_agg(to_jsonb(o) order by o.factor_rate, o.created_at)
                                    from offers o where o.submission_id = s.id), '[]'::jsonb)
            ) as j
       from submissions s
       join funders f on f.id = s.funder_id
       join app_users u on u.id = s.user_id
      where s.client_id = $1
      order by s.sent_on desc, lower(f.name)`,
    [clientId],
  );
}

/** What the client page needs: the funder list (for the Send dialog) and this merchant's submissions. */
export async function getClientFundersData(q: Db, clientId: string): Promise<ClientFundersData> {
  const funders = await listFunders(q);
  const submissions = await listClientSubmissions(q, clientId);
  return { funders, submissions };
}

/** Per-funder results across every merchant. Plain rows out of SQL; the math is buildScoreboard (pure, tested). */
export async function funderScoreboard(
  q: Db,
  funderIds: readonly string[],
): Promise<Record<string, ScoreRow>> {
  const subs = await json<SubmissionStat>(
    q,
    `select to_jsonb(x) as j from (
       select s.funder_id, s.status, s.decline_reason, s.sent_on::text as sent_on,
              (s.responded_at at time zone u.timezone)::date::text as responded_on
         from submissions s join app_users u on u.id = s.user_id
     ) x`,
  );
  const offers = await json<OfferStat>(
    q,
    `select to_jsonb(x) as j from (
       select s.funder_id, o.factor_rate
         from offers o join submissions s on s.id = o.submission_id
     ) x`,
  );
  return buildScoreboard(funderIds, subs, offers);
}
