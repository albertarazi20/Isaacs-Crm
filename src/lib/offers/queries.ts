import type { Db } from "../db";
import type { Frequency, OfferDoc } from "./terms";

export type OfferState = "sent" | "accepted" | "withdrawn" | "expired";

export interface OfferRow {
  id: string;
  client_id: string;
  approval_id: string | null;
  token: string;
  funded_cents: number;
  factor_rate: number;
  frequency: Frequency;
  payments: number;
  payback_cents: number;
  payment_cents: number;
  funder: string;
  message: string;
  docs: OfferDoc[];
  expires_at: string;
  status: "sent" | "accepted" | "withdrawn";
  /** What it is now: a sent offer past its date has expired. */
  state: OfferState;
  views: number;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  accepted_at: string | null;
  accepted_name: string;
  withdrawn_at: string | null;
  created_at: string;
  created_by_name: string;
  /** Where the email that carried it stands: queued, sent, failed… or null when it was not emailed. */
  email_status: string | null;
  email_note: string | null;
}

export const OFFER_SELECT = `
  select o.id, o.client_id, o.approval_id, o.token, o.funded_cents::float8 as funded_cents, o.factor_rate::float8 as factor_rate,
         o.frequency, o.payments, o.payback_cents::float8 as payback_cents, o.payment_cents::float8 as payment_cents,
         o.funder, o.message, o.docs, o.expires_at::text as expires_at, o.status,
         case when o.status = 'sent' and o.expires_at <= now() then 'expired' else o.status end as state,
         o.views, o.first_viewed_at::text as first_viewed_at, o.last_viewed_at::text as last_viewed_at,
         o.accepted_at::text as accepted_at, o.accepted_name, o.withdrawn_at::text as withdrawn_at,
         o.created_at::text as created_at, coalesce(nullif(u.name, ''), u.email, '') as created_by_name,
         ob.status as email_status, coalesce(ob.skip_reason, ob.last_error) as email_note
    from merchant_offers o
    join app_users u on u.id = o.user_id
    left join outbox ob on ob.id = o.outbox_id`;

/** A merchant's offers, newest first, as the signed-in person may see them. */
export async function listOffers(q: Db, clientId: string): Promise<OfferRow[]> {
  const { rows } = await q.query<OfferRow>(
    `${OFFER_SELECT} where o.client_id = $1 order by o.created_at desc limit 20`,
    [clientId],
  );
  return rows;
}
