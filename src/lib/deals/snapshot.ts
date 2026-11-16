/** Everything `suggestNextStep` and `milestones` need about one deal, in four queries under RLS. */
import type { Db } from "../db";
import { freshness } from "../docs/freshness";
import { labelOf, monthName, type DocKind } from "../docs/label";
import type { ISODate } from "../mca/dates";
import type { DealSnapshot, LenderLine, OfferLine } from "./nextStep";
import type { DealStatus, KickbackReason } from "./types";

export async function loadDealSnapshot(
  q: Db,
  dealId: string,
  today: ISODate,
): Promise<DealSnapshot | null> {
  const { rows } = await q.query<{
    client_id: string;
    status: DealStatus;
    contact_name: string;
    business_name: string;
    created_on: string;
    queued_at: string;
    kicked_back_at: string | null;
    kickback_reason: KickbackReason | null;
    kickback_note: string;
    sent_on: string | null;
    blocker: string;
    reply_waiting: boolean;
    reply_subject: string;
    chase_after_days: number;
    ai_next_step: string | null;
    funded_on: string | null;
    renewal_eligible_on: string | null;
    ledger_state: string | null;
  }>(
    `select d.client_id, app.deal_status(d) as status, c.contact_name, c.business_name, d.created_at::date::text as created_on,
            to_char(d.queued_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as queued_at,
            to_char(d.kicked_back_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as kicked_back_at, d.kickback_reason, d.kickback_note, d.sent_at::date::text as sent_on, d.blocker,
            c.reply_waiting_since is not null as reply_waiting, c.reply_waiting_subject as reply_subject,
            (select lender_chase_days from shop_settings) as chase_after_days,
            (select p.next_step from proposed_updates p where p.deal_id = d.id and p.next_step <> '' and p.created_at > d.updated_at
              order by p.created_at desc limit 1) as ai_next_step,
            f.funded_on::text as funded_on, f.renewal_eligible_on::text as renewal_eligible_on, f.ledger_state
       from deals d join clients c on c.id = d.client_id
       left join lateral (select * from fundings f where f.deal_id = d.id order by f.created_at desc limit 1) f on true
      where d.id = $1`,
    [dealId],
  );
  const d = rows[0];
  if (!d) return null;

  const lenders = (
    await q.query<LenderLine & { stips: string[] | null }>(
      `select fu.name, s.status, s.sent_on::text as sent_on, s.responded_at::date::text as responded_on,
              s.last_chased_at::date::text as last_chased_on, s.chase_count, s.approval_expires_on::text as approval_expires_on,
              s.decline_reason,
              (select coalesce(array_agg(x), '{}') from (
                 select jsonb_array_elements_text(p.payload->'stips') as x from proposed_updates p
                  where p.submission_id = s.id and p.event = 'stip_requested' and p.status in ('auto', 'applied')
                  order by p.created_at desc limit 1) y) as stips
         from submissions s join funders fu on fu.id = s.funder_id
        where s.deal_id = $1 order by s.sent_on, s.created_at`,
      [dealId],
    )
  ).rows.map((l) => ({ ...l, stips: l.stips ?? [] }));

  const offers = (
    await q.query<OfferLine>(
      `select fu.name as funder_name, o.amount_cents, o.factor_rate::float as factor_rate, o.status, o.received_on::text as received_on,
              coalesce(o.expires_on, s.approval_expires_on)::text as expires_on
         from offers o join submissions s on s.id = o.submission_id join funders fu on fu.id = s.funder_id
        where o.deal_id = $1 order by o.received_on, o.created_at`,
      [dealId],
    )
  ).rows.map((o) => ({ ...o, amount_cents: Number(o.amount_cents) }));

  const stips = await q.query<{ kind: DocKind; period: string | null }>(
    "select kind, period::text as period from stips where client_id = $1 and required and received_at is null order by kind, period",
    [d.client_id],
  );
  const have = await q.query<{ p: string }>(
    `select distinct period::text as p from (
       select period from documents where client_id = $1 and kind = 'bank_statement' and period is not null and deleted_at is null
       union select period from stips where client_id = $1 and kind = 'bank_statement' and period is not null and received_at is not null) x`,
    [d.client_id],
  );
  const fresh = freshness(
    have.rows.map((r) => r.p),
    today,
  );

  return {
    today,
    status: d.status,
    contact_name: d.contact_name,
    business_name: d.business_name,
    created_on: d.created_on,
    queued_at: d.queued_at,
    kicked_back_at: d.kicked_back_at,
    kickback_reason: d.kickback_reason,
    kickback_note: d.kickback_note,
    sent_on: d.sent_on,
    blocker: d.blocker,
    reply_waiting: d.reply_waiting,
    reply_subject: d.reply_subject,
    lenders,
    offers,
    stips_missing: stips.rows.map((s) => labelOf(s.kind, s.period)),
    statement_wanted:
      fresh.status === "stale" && fresh.monthsBehind > 0 ? monthName(fresh.expected) : null,
    funding: d.funded_on
      ? {
          funded_on: d.funded_on,
          renewal_eligible_on: d.renewal_eligible_on,
          ledger_state: d.ledger_state ?? "expected",
        }
      : null,
    ai_next_step: d.ai_next_step,
    chase_after_days: d.chase_after_days,
  };
}
