import type { Db } from "../db";

export type ApprovalStatus = "open" | "pitched" | "closed";
export type EmailsState = "running" | "paused" | "stopped" | "finished";

export interface SentStep {
  step: number;
  /** sent, queued, sending, failed, skipped, cancelled: the latest try at this step */
  status: string;
  at: string;
}

export interface ApprovalRow {
  id: string;
  client_id: string;
  business_name: string;
  contact_name: string;
  phone: string;
  email: string;
  /** The merchant's own time zone (IANA), for their clock beside the number. */
  timezone: string;
  amount_cents: number;
  hold_until: string | null;
  funder: string;
  note: string;
  status: ApprovalStatus;
  emails: EmailsState;
  emails_note: string;
  /** What would stop the emails right now (app.approval_halt), before the engine has run. */
  halt: string | null;
  next_step: number | null;
  next_email_at: string | null;
  created_at: string;
  created_by_name: string;
  rep_id: string;
  rep_name: string;
  pitched_at: string | null;
  pitched_by_name: string;
  closed_at: string | null;
  closed_reason: string;
  last_call_at: string | null;
  /** The merchant answered since the emails started and nobody has called since: the rep's next call. */
  needs_call: boolean;
  /** The merchant's newest offer, if any: where it stands and whether they opened it. */
  offer: {
    state: "sent" | "accepted" | "withdrawn" | "expired";
    views: number;
    last_viewed_at: string | null;
    funded_cents: number;
  } | null;
  steps: SentStep[];
}

const SELECT = `
  select a.id, a.client_id, c.business_name, c.contact_name, c.phone, c.email, app.client_timezone(c) as timezone,
         a.amount_cents::float8 as amount_cents, a.hold_until::text as hold_until, a.funder, a.note, a.status, a.emails,
         a.emails_note, app.approval_halt(a.id) as halt, a.next_step, a.next_email_at::text as next_email_at,
         a.created_at::text as created_at, coalesce(cb.name, '') as created_by_name,
         a.user_id as rep_id, coalesce(u.name, u.email, '') as rep_name,
         a.pitched_at::text as pitched_at, coalesce(pb.name, '') as pitched_by_name,
         a.closed_at::text as closed_at, a.closed_reason,
         (select max(x.created_at)::text from activities x
           where x.client_id = a.client_id and x.kind = 'call' and x.created_at >= a.created_at) as last_call_at,
         coalesce(app.approval_needs_call(a.id), false) as needs_call,
         (select json_build_object('state', case when mo.status = 'sent' and mo.expires_at <= now() then 'expired' else mo.status end,
                                   'views', mo.views, 'last_viewed_at', mo.last_viewed_at, 'funded_cents', mo.funded_cents::float8)
            from merchant_offers mo where mo.client_id = a.client_id
           order by (mo.approval_id is not distinct from a.id) desc, mo.created_at desc limit 1) as offer,
         
         coalesce((select json_agg(json_build_object('step', s.step, 'status', s.status, 'at', s.at) order by s.step)
                     from (select distinct on (split_part(o.source, ':', 4)::int)
                                  split_part(o.source, ':', 4)::int as step, o.status,
                                  coalesce(o.sent_at, o.not_before)::text as at
                             from outbox o
                            where o.lane = 'approval' and o.source like 'approval:' || a.id::text || ':step:%'
                            order by split_part(o.source, ':', 4)::int, (o.status = 'sent') desc, o.created_at desc) s),
                  '[]'::json) as steps
    from approvals a
    join clients c on c.id = a.client_id
    left join app_users u on u.id = a.user_id
    left join app_users cb on cb.id = a.created_by
    left join app_users pb on pb.id = a.pitched_by`;

/**
 * The page's list. Open ones: a reply first (call them), then the ones whose hold runs out soonest, then the newest.
 * Pitched and closed: the latest first.
 */
export async function listApprovals(q: Db, status: ApprovalStatus): Promise<ApprovalRow[]> {
  const order =
    status === "open"
      ? `order by coalesce(app.approval_needs_call(a.id), false) desc,
                  a.hold_until asc nulls last, a.created_at desc`
      : status === "pitched"
        ? "order by a.pitched_at desc"
        : "order by a.closed_at desc";
  const { rows } = await q.query<ApprovalRow>(
    `${SELECT}
     where a.status = $1
       and not exists (select 1 from trashed_clients t where t.client_id = a.client_id)
     ${order}
     limit 500`,
    [status],
  );
  return rows;
}

/** The merchant page: the open approval, else the latest one. */
export async function approvalForClient(q: Db, clientId: string): Promise<ApprovalRow | null> {
  const { rows } = await q.query<ApprovalRow>(
    `${SELECT} where a.client_id = $1 order by (a.status = 'open') desc, a.created_at desc limit 1`,
    [clientId],
  );
  return rows[0] ?? null;
}

export interface ApprovalStats {
  open: number;
  open_cents: number;
  replied: number;
  expiring: number;
  pitched_7d: number;
  pitched_cents_7d: number;
}

/** The numbers over the list. `expiring`: open ones whose hold ends within three days (or has ended). */
export async function approvalStats(q: Db): Promise<ApprovalStats> {
  const { rows } = await q.query<ApprovalStats>(
    `select count(*) filter (where a.status = 'open')::int as open,
            coalesce(sum(a.amount_cents) filter (where a.status = 'open'), 0)::float8 as open_cents,
            count(*) filter (where a.status = 'open' and coalesce(app.approval_needs_call(a.id), false))::int as replied,
            count(*) filter (where a.status = 'open' and a.hold_until is not null
                             and a.hold_until <= current_date + 3)::int as expiring,
            count(*) filter (where a.status = 'pitched' and a.pitched_at > now() - interval '7 days')::int as pitched_7d,
            coalesce(sum(a.amount_cents) filter (where a.status = 'pitched'
                                                 and a.pitched_at > now() - interval '7 days'), 0)::float8
              as pitched_cents_7d
       from approvals a
      where not exists (select 1 from trashed_clients t where t.client_id = a.client_id)`,
  );
  return (
    rows[0] ?? {
      open: 0,
      open_cents: 0,
      replied: 0,
      expiring: 0,
      pitched_7d: 0,
      pitched_cents_7d: 0,
    }
  );
}

/** The sidebar's number: open approvals waiting on a pitch. */
export async function openApprovalCount(q: Db): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    `select count(*)::int as n from approvals a
      where a.status = 'open' and not exists (select 1 from trashed_clients t where t.client_id = a.client_id)`,
  );
  return rows[0]?.n ?? 0;
}

export interface CadenceRow {
  step: number;
  delay_hours: number;
  ready: boolean;
  /** The design quotes the funder's hold date, so an approval without one waits at this email. */
  uses_expiry: boolean;
  /** The design asks the merchant to call the rep, so a rep without a phone number holds it. */
  uses_phone: boolean;
}

export interface ApprovalEmailRow {
  step: number;
  subject: string;
  html: string;
  file_name: string;
  delay_hours: number;
  updated_at: string;
  updated_by_name: string;
}

export async function listApprovalEmails(q: Db): Promise<ApprovalEmailRow[]> {
  const { rows } = await q.query<ApprovalEmailRow>(
    `select e.step, e.subject, e.html, e.file_name, e.delay_hours, e.updated_at::text as updated_at,
            coalesce(u.name, '') as updated_by_name
       from approval_emails e left join app_users u on u.id = e.updated_by
      order by e.step`,
  );
  return rows;
}

export interface ApprovalSettingsRow {
  approval_emails_on: boolean;
  approval_window_start: number;
  approval_window_end: number;
  approval_weekends: boolean;
  postal_address: string;
}

export async function getApprovalSettings(q: Db): Promise<ApprovalSettingsRow> {
  const { rows } = await q.query<ApprovalSettingsRow>(
    `select approval_emails_on, approval_window_start, approval_window_end, approval_weekends, postal_address
       from shop_settings`,
  );
  const r = rows[0];
  if (!r) throw new Error("shop_settings row missing");
  return r;
}

/** The emails as a merchant would get them (for the merchant page and the list): step count and the delays. */
export async function approvalCadence(q: Db): Promise<CadenceRow[]> {
  const { rows } = await q.query<CadenceRow>(
    `select step, delay_hours, (btrim(html) <> '' and btrim(subject) <> '') as ready,
            html ~ '\{\{\s*offer_expiry\s*\}\}' or subject ~ '\{\{\s*offer_expiry\s*\}\}' as uses_expiry,
            html ~ '\{\{\s*rep_phone\s*\}\}' as uses_phone
       from approval_emails order by step`,
  );
  return rows;
}
