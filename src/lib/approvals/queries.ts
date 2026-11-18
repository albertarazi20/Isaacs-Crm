import type { Db } from "../db";
import { fieldsIn } from "./html";

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
                     from (select x.step, x.status, x.at
                             from (select distinct on (split_part(o.source, ':', 4)::int)
                                          split_part(o.source, ':', 4)::int as step, o.status,
                                          coalesce(o.sent_at, o.not_before)::text as at
                                     from outbox o
                                    where o.lane = 'approval' and o.source like 'approval:' || a.id::text || ':step:%'
                                    order by split_part(o.source, ':', 4)::int, (o.status = 'sent') desc, o.created_at desc) x
                            -- the first email the rep sent by hand (approvals.first_sent_at) is step 1 sent, and
                            -- stands in for a step 1 on the outbox that never went out
                            where not (x.step = 1 and a.first_sent_at is not null and x.status <> 'sent')
                           union all
                           select 1, 'sent', a.first_sent_at::text
                            where a.first_sent_at is not null
                              and not exists (select 1 from outbox o2
                                               where o2.lane = 'approval' and o2.status = 'sent'
                                                 and o2.source = 'approval:' || a.id::text || ':step:1')) s),
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
                             and a.hold_until <= (now() at time zone app.client_timezone(c))::date + 3)::int as expiring,
            count(*) filter (where a.status = 'pitched' and a.pitched_at > now() - interval '7 days')::int as pitched_7d,
            coalesce(sum(a.amount_cents) filter (where a.status = 'pitched'
                                                 and a.pitched_at > now() - interval '7 days'), 0)::float8
              as pitched_cents_7d
       from approvals a
       join clients c on c.id = a.client_id
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
  const { rows } = await q.query<{
    step: number;
    delay_hours: number;
    ready: boolean;
    subject: string;
    html: string;
  }>(
    `select step, delay_hours, (btrim(html) <> '' and btrim(subject) <> '') as ready, subject, html
       from approval_emails order by step`,
  );
  // the engine's own field rule (spaces and any letter case count), not a second one written in SQL
  return rows.map((r) => {
    const used = [...fieldsIn(r.html).used, ...fieldsIn(r.subject).used];
    return {
      step: r.step,
      delay_hours: r.delay_hours,
      ready: r.ready,
      uses_expiry: used.includes("offer_expiry"),
      uses_phone: used.includes("rep_phone"),
    };
  });
}
