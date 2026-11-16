/**
 * Lender payout tracking (plan §9.7; audit S3-6): every confirmed funding carries the day the lender's own terms say
 * the commission should arrive (funded_on + commission_paid_after_days). Past that day with money still owed, the
 * funding is late; the generator in src/lib/system/alerts.ts tells the rep and the managers once.
 */
import type { Db } from "../db";
import type { ISODate } from "../mca/dates";

export interface Payout {
  funding_id: string;
  client_id: string;
  deal_id: string | null;
  business_name: string;
  rep_name: string;
  funder_name: string;
  funded_on: ISODate;
  commission_cents: number;
  received_cents: number;
  owed_cents: number;
  expected_on: ISODate;
  /** Positive = days late; negative = days until due. */
  days_late: number;
  ledger_state: string;
}

/** Confirmed fundings with commission still owed, late ones first. RLS scopes them: a rep's own, a manager's shop. */
export async function listPayouts(q: Db, today: ISODate): Promise<Payout[]> {
  const { rows } = await q.query<{ j: Payout }>(
    `select to_jsonb(x) as j from (
       select f.id as funding_id, f.client_id, f.deal_id, c.business_name, u.name as rep_name, f.funder_name,
              f.funded_on::text as funded_on, coalesce(f.commission_cents, 0)::bigint as commission_cents,
              coalesce(f.commission_received_cents, 0)::bigint as received_cents,
              (coalesce(f.commission_cents, 0) - coalesce(f.commission_received_cents, 0))::bigint as owed_cents,
              f.commission_expected_on::text as expected_on, ($1::date - f.commission_expected_on)::int as days_late, f.ledger_state
         from fundings f join clients c on c.id = f.client_id join app_users u on u.id = f.user_id
        where f.confirmed_at is not null and f.commission_expected_on is not null
          and f.ledger_state in ('expected', 'at_risk', 'paid')
          and coalesce(f.commission_received_cents, 0) < coalesce(f.commission_cents, 0)
          and not exists (select 1 from trashed_clients tc where tc.client_id = f.client_id)
        order by ($1::date - f.commission_expected_on) desc, f.funded_on
     ) x`,
    [today],
  );
  return rows.map((r) => ({
    ...r.j,
    commission_cents: Number(r.j.commission_cents),
    received_cents: Number(r.j.received_cents),
    owed_cents: Number(r.j.owed_cents),
  }));
}

/** Only the late ones: the lender's own pay-after window has passed. */
export async function latePayouts(q: Db, today: ISODate): Promise<Payout[]> {
  return (await listPayouts(q, today)).filter((p) => p.days_late > 0);
}
