import type { Db } from "../db";
import { OPENER_REVIEW_HOURS } from "./winback";

/**
 * Read side for the Winback page's newer controls (audit S3-11): the rescue nudges already sent on a member's deal,
 * whether a one-click reshop is open to them, and the openers Claude drafted that a manager has not yet released.
 * Reads run as the signed-in person, so RLS keeps a rep to their own members.
 */

export interface MemberExtra {
  /** Days (20, 25, 29) a rescue nudge already went out on this member's deal. */
  rescue_days: number[];
  /** The merchant has an open deal every lender declined, so start_reshop would accept it. */
  can_reshop: boolean;
}

export async function memberExtras(q: Db): Promise<Record<string, MemberExtra>> {
  const { rows } = await q.query<{ id: string; rescue_days: number[]; can_reshop: boolean }>(
    `select m.id,
            coalesce((select array_agg(r.day order by r.day) from rescue_nudges r where r.deal_id = m.deal_id), '{}'::int[]) as rescue_days,
            exists (select 1 from deals d where d.client_id = m.client_id and d.outcome = 'open'
                       and app.deal_status(d) = 'declined_by_all') as can_reshop
       from winback_members m
      where m.status in ('waiting', 'active', 'replied', 'stopped')`,
  );
  return Object.fromEntries(
    rows.map((r) => [r.id, { rescue_days: r.rescue_days, can_reshop: r.can_reshop }]),
  );
}

export interface DraftedOpener {
  id: string;
  client_id: string;
  business_name: string;
  contact_name: string;
  pool: string;
  pool_name: string;
  opener: string;
  drafted_at: string | null;
  /** After this the first email goes without the line (review mode holds step 1 this long). */
  hold_until: string | null;
}

/** Drafted and not yet released: step 1 has not gone out, a manager has not approved or skipped the line. */
export async function draftedOpeners(q: Db): Promise<DraftedOpener[]> {
  const { rows } = await q.query<DraftedOpener>(
    `select m.id, m.client_id, c.business_name, c.contact_name, m.pool, p.name as pool_name, m.opener,
            m.opener_drafted_at::text as drafted_at,
            (m.opener_drafted_at + make_interval(hours => $1::int))::text as hold_until
       from winback_members m
       join winback_pools p on p.key = m.pool
       join clients c on c.id = m.client_id
      where m.opener_status = 'drafted' and m.status in ('waiting', 'active') and m.next_step = 1 and m.steps_sent = 0
        and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
      order by m.opener_drafted_at, c.business_name`,
    [OPENER_REVIEW_HOURS],
  );
  return rows;
}

export type OpenerMode = "auto" | "review";

export async function openerMode(q: Db): Promise<OpenerMode> {
  const { rows } = await q.query<{ m: OpenerMode }>(
    "select winback_opener_mode as m from shop_settings limit 1",
  );
  return rows[0]?.m ?? "review";
}
