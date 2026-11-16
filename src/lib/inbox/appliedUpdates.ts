import type { Db } from "../db";

/**
 * The Review tray's second list: what the AI already applied (by itself, or after a manager's yes) with what the
 * lender row said before, so a manager can put it back (revert_ai_update, 0511). Newest first, the last two weeks.
 */
export interface AppliedUpdate {
  id: string;
  event: string;
  summary: string;
  status: "applied" | "reverted";
  source: "email" | "pasted";
  /** When it was applied (or, for an undone one, applied then undone: the later of the two). */
  at: string;
  deal_id: string;
  deal_number: number;
  business_name: string;
  funder_name: string | null;
  submission_id: string | null;
  /** The lender row's status before the update; null when the update changed no row. */
  previous_status: string | null;
  /** The lender row's status now. */
  current_status: string | null;
  /** The update added an offer, which undoing removes. */
  created_offer: boolean;
  /** An applied update that changed a row, is not a funding, and is the newest one on that row. */
  can_undo: boolean;
  reverted_by_name: string | null;
}

export async function listAppliedUpdates(q: Db, days = 14, limit = 50): Promise<AppliedUpdate[]> {
  const { rows } = await q.query<AppliedUpdate>(
    `select p.id, p.event, p.summary, p.status, p.source,
            to_char(coalesce(p.reverted_at, p.decided_at, p.created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at,
            p.deal_id, d.number as deal_number, c.business_name, f.name as funder_name, p.submission_id,
            p.previous_status, s.status as current_status, p.created_offer_id is not null as created_offer,
            (p.status = 'applied' and p.submission_id is not null and p.previous_status is not null and p.event <> 'funded'
              and not exists (select 1 from proposed_updates n
                               where n.submission_id = p.submission_id and n.status = 'applied' and n.id <> p.id
                                 and coalesce(n.decided_at, n.created_at) > coalesce(p.decided_at, p.created_at))) as can_undo,
            ru.name as reverted_by_name
       from proposed_updates p
       join deals d on d.id = p.deal_id
       join clients c on c.id = d.client_id
       left join submissions s on s.id = p.submission_id
       left join funders f on f.id = s.funder_id
       left join app_users ru on ru.id = p.reverted_by
      where p.status in ('applied', 'reverted')
        and p.submission_id is not null and p.previous_status is not null
        and coalesce(p.reverted_at, p.decided_at, p.created_at) > now() - make_interval(days => $1::int)
      order by coalesce(p.reverted_at, p.decided_at, p.created_at) desc
      limit $2`,
    [days, limit],
  );
  return rows;
}
