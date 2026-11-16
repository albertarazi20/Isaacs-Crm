/**
 * The speed numbers (plan §3.6; audit S3-12) for one person or the whole shop: medians, in days, over the month's
 * deals. The same three medians sit in each row of repScorecard; this is the one-line version for the dashboard's
 * speed card. Runs under RLS, so a rep's "shop" is their own book.
 */
import type { Db } from "../db";

export interface SpeedNumbers {
  /** Lead landed → file sent to lenders, for deals sent this month. */
  lead_to_sub_days: number | null;
  /** Sent to lenders → the first offer in, for deals whose first offer came this month. */
  sub_to_offer_days: number | null;
  /** First approval → funded, for fundings confirmed this month. */
  approval_to_funded_days: number | null;
  /** Deals behind each median, so a median of one deal reads as one deal. */
  sample: { lead_to_sub: number; sub_to_offer: number; approval_to_funded: number };
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function speedNumbers(
  q: Db,
  month: string,
  userId: string | null = null,
): Promise<SpeedNumbers> {
  if (!MONTH.test(month)) throw new Error(`bad month: ${month}`);
  const { rows } = await q.query<{
    lead_to_sub: string | null;
    lead_to_sub_n: number;
    sub_to_offer: string | null;
    sub_to_offer_n: number;
    approval_to_funded: string | null;
    approval_to_funded_n: number;
  }>(
    `select
       (select round(percentile_cont(0.5) within group (order by extract(epoch from (d.sent_at - c.created_at)) / 86400)::numeric, 1)::text
          from deals d join clients c on c.id = d.client_id
         where ($2::uuid is null or d.user_id = $2) and d.sent_at is not null and to_char(d.sent_at, 'YYYY-MM') = $1) as lead_to_sub,
       (select count(*)::int from deals d
         where ($2::uuid is null or d.user_id = $2) and d.sent_at is not null and to_char(d.sent_at, 'YYYY-MM') = $1) as lead_to_sub_n,
       (select round(percentile_cont(0.5) within group (order by (o.first_offer - d.sent_at::date))::numeric, 1)::text
          from deals d join lateral (select min(o.received_on) as first_offer from offers o where o.deal_id = d.id) o on true
         where ($2::uuid is null or d.user_id = $2) and d.sent_at is not null and o.first_offer is not null
           and to_char(o.first_offer, 'YYYY-MM') = $1) as sub_to_offer,
       (select count(*)::int from deals d join lateral (select min(o.received_on) as first_offer from offers o where o.deal_id = d.id) o on true
         where ($2::uuid is null or d.user_id = $2) and d.sent_at is not null and o.first_offer is not null
           and to_char(o.first_offer, 'YYYY-MM') = $1) as sub_to_offer_n,
       (select round(percentile_cont(0.5) within group (order by (f.funded_on - a.approved_on))::numeric, 1)::text
          from fundings f join lateral (select min(coalesce(s.responded_at, s.status_changed_at))::date as approved_on from submissions s
                                          where s.deal_id = f.deal_id and s.status in ('approved', 'revised', 'contracts_out', 'contracts_in', 'funding_call', 'funded')) a on true
         where ($2::uuid is null or f.user_id = $2) and f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1
           and a.approved_on is not null) as approval_to_funded,
       (select count(*)::int from fundings f join lateral (select min(coalesce(s.responded_at, s.status_changed_at))::date as approved_on from submissions s
                                          where s.deal_id = f.deal_id and s.status in ('approved', 'revised', 'contracts_out', 'contracts_in', 'funding_call', 'funded')) a on true
         where ($2::uuid is null or f.user_id = $2) and f.confirmed_at is not null and to_char(f.funded_on, 'YYYY-MM') = $1
           and a.approved_on is not null) as approval_to_funded_n`,
    [month, userId],
  );
  const r = rows[0];
  const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
  return {
    lead_to_sub_days: num(r?.lead_to_sub),
    sub_to_offer_days: num(r?.sub_to_offer),
    approval_to_funded_days: num(r?.approval_to_funded),
    sample: {
      lead_to_sub: r?.lead_to_sub_n ?? 0,
      sub_to_offer: r?.sub_to_offer_n ?? 0,
      approval_to_funded: r?.approval_to_funded_n ?? 0,
    },
  };
}
