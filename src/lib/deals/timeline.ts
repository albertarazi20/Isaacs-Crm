/**
 * The deal's Activity feed: one ordered list from eight tables — the rep's notes and calls, emails in and out, what
 * the AI read (and whether a manager still has to look), lender rows and offers, documents, the funding. Newest first.
 */
import type { Db } from "../db";

export type TimelineKind =
  | "note"
  | "call"
  | "email_in"
  | "email_out"
  | "ai"
  | "lender"
  | "offer"
  | "document"
  | "funding"
  | "ops"
  | "system";

export interface TimelineEvent {
  at: string;
  kind: TimelineKind;
  title: string;
  detail: string;
  /** Who or what did it: a name, "merchant", "lender", "AI", "system". */
  actor: string;
  /** A manager still has to accept or reject this (AI proposal). */
  needs_review: boolean;
  ref_type:
    | "activity"
    | "inbound_email"
    | "outbox"
    | "proposed_update"
    | "submission"
    | "offer"
    | "document"
    | "funding"
    | "deal";
  ref_id: string;
}

export async function listDealTimeline(
  q: Db,
  dealId: string,
  limit = 200,
): Promise<TimelineEvent[]> {
  const { rows } = await q.query<{ j: TimelineEvent }>(
    `with d as (select id, client_id, created_at from deals where id = $1)
     select to_jsonb(x) as j from (
       -- the rep's notes, calls and stage moves since the deal opened
       select a.occurred_at as at,
              case a.kind when 'note' then 'note' when 'call' then 'call' when 'email' then 'email_in' when 'funding' then 'funding' else 'system' end as kind,
              case a.kind when 'call' then 'Call' || coalesce(' — ' || replace(a.outcome, '_', ' '), '')
                          when 'note' then 'Note' when 'stage_change' then 'Stage: ' || coalesce(a.to_stage, '')
                          when 'email' then case when a.body like 'Merchant replied%' then 'Merchant replied' else 'Email' end
                          else 'Update' end as title,
              a.body as detail,
              coalesce(u.name, case when a.kind = 'email' and a.body like 'Merchant replied%' then 'merchant' else 'system' end) as actor,
              false as needs_review, 'activity' as ref_type, a.id::text as ref_id
         from d join activities a on a.client_id = d.client_id and a.occurred_at >= d.created_at - interval '1 minute'
         left join app_users u on u.id = a.user_id and a.kind in ('note', 'call', 'text')
        where a.body not like '[needs review] %' and a.body not like 'Received %' and a.body not like 'Chased %'
       union all
       -- lender emails in
       select e.received_at, 'email_in', coalesce(fu.name, e.from_name, e.from_address) || ': ' || left(e.subject, 90),
              left(e.snippet, 240), 'lender', false, 'inbound_email', e.id::text
         from d join inbound_emails e on e.deal_id = d.id left join funders fu on fu.id = e.funder_id
       union all
       -- what the AI read from each of those, and whether a manager must still decide
       select p.created_at, 'ai', p.summary, coalesce(nullif(p.next_step, ''), ''), 'AI',
              p.status = 'proposed', 'proposed_update', p.id::text
         from d join proposed_updates p on p.deal_id = d.id
        where p.event <> 'no_change'
       union all
       -- emails we sent on this deal (submissions, chases, sequences)
       select coalesce(o.sent_at, o.created_at), 'email_out',
              case o.lane when 'intake' then 'Welcome email' when 'sequence' then 'Reminder' when 'blast' then 'Blast' when 'reply' then 'Reply' else 'Email' end
                || ' to ' || o.to_address || case o.status when 'sent' then '' when 'skipped' then ' (skipped: ' || coalesce(o.skip_reason, '') || ')' when 'failed' then ' (failed)' when 'cancelled' then ' (cancelled)' else ' (queued)' end,
              left(o.subject, 120), coalesce(u.name, 'system'), false, 'outbox', o.id::text
         from d join outbox o on (o.deal_id = d.id or (o.client_id = d.client_id and o.created_at >= d.created_at))
         left join app_users u on u.id = o.user_id
        where o.status in ('sent', 'skipped', 'failed', 'cancelled', 'queued')
       union all
       -- lender rows: sent, and every later status
       select s.created_at, 'lender', 'Sent to ' || fu.name, coalesce(nullif(s.note, ''), ''), 'ops', false, 'submission', s.id::text
         from d join submissions s on s.deal_id = d.id join funders fu on fu.id = s.funder_id
       union all
       select s.status_changed_at, 'lender', fu.name || ': ' || replace(s.status, '_', ' ')
                || case when s.status = 'declined' and s.decline_reason is not null then ' (' || app.decline_reason_label(s.decline_reason) || ')' else '' end,
              coalesce(nullif(s.decline_note, ''), ''), case s.source when 'email' then 'AI' when 'rule' then 'system' else 'ops' end, false, 'submission', s.id::text
         from d join submissions s on s.deal_id = d.id join funders fu on fu.id = s.funder_id
        where s.status <> 'sent'
       union all
       select s.last_chased_at, 'email_out', 'Chased ' || fu.name, 'Nudge on the submission thread', 'system', false, 'submission', s.id::text
         from d join submissions s on s.deal_id = d.id join funders fu on fu.id = s.funder_id
        where s.last_chased_at is not null
       union all
       -- offers
       select o.created_at, 'offer', 'Offer from ' || fu.name || ': ' || app.fmt_money(o.amount_cents) || ' at ' || o.factor_rate
                || case when o.status <> 'open' then ' (' || o.status || ')' else '' end,
              coalesce(nullif(o.note, ''), ''), 'lender', false, 'offer', o.id::text
         from d join offers o on o.deal_id = d.id join submissions s on s.id = o.submission_id join funders fu on fu.id = s.funder_id
       union all
       -- documents
       select doc.created_at, 'document', 'Received ' || app.document_label(doc.kind, doc.period),
              doc.filename || case doc.source when 'upload_link' then ' (merchant upload)' when 'email' then ' (from email)' else '' end,
              case doc.source when 'upload_link' then 'merchant' when 'email' then 'system' else coalesce(u.name, 'staff') end, false, 'document', doc.id::text
         from d join documents doc on (doc.deal_id = d.id or (doc.client_id = d.client_id and doc.created_at >= d.created_at))
         left join app_users u on u.id = doc.uploaded_by
        where doc.deleted_at is null
       union all
       -- the funding
       select f.created_at, 'funding', 'FUNDED ' || app.fmt_money(f.amount_cents) || ' by ' || f.funder_name
                || case when f.confirmed_at is null then ' (waiting for a manager)' else '' end,
              coalesce(app.points_of(f)::text || ' points', ''), coalesce(u.name, 'rep'), f.confirmed_at is null, 'funding', f.id::text
         from d join fundings f on f.deal_id = d.id left join app_users u on u.id = f.proposed_by
       union all
       -- the ops loop
       select dd.queued_at, 'ops', 'Submitted to ops', '', 'rep', false, 'deal', dd.id::text from d join deals dd on dd.id = d.id
       union all
       select dd.kicked_back_at, 'ops', 'Kicked back: ' || coalesce(replace(dd.kickback_reason, '_', ' '), ''), dd.kickback_note, 'ops', false, 'deal', dd.id::text
         from d join deals dd on dd.id = d.id where dd.kicked_back_at is not null
       union all
       select dd.sent_at, 'ops', 'Sent to lenders', '', 'ops', false, 'deal', dd.id::text from d join deals dd on dd.id = d.id where dd.sent_at is not null
       union all
       select dd.closed_at, 'ops', 'Closed: ' || dd.outcome, dd.outcome_reason, 'system', false, 'deal', dd.id::text from d join deals dd on dd.id = d.id where dd.closed_at is not null
     ) x order by x.at desc limit $2`,
    [dealId, limit],
  );
  return rows.map((r) => r.j);
}
