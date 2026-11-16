/**
 * The manager's trust panel and the leak tracer (plan §14). Everything here reads the access log, document views
 * and the lender rows; writing is one function, `logAccess`, which every copy/view button calls.
 */
import type { Db } from "../db";
import { UserError } from "../data/mutations";

export const ACCESS_ACTIONS = [
  "view_contact",
  "copy_contact",
  "copy_phone",
  "copy_email",
  "download",
  "mass_view",
] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export async function logAccess(
  q: Db,
  a: {
    userId: string;
    action: AccessAction;
    clientId?: string | null;
    documentId?: string | null;
    detail?: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<void> {
  await q.query(
    `insert into access_log (user_id, action, client_id, document_id, detail, ip, user_agent) values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      a.userId,
      a.action,
      a.clientId ?? null,
      a.documentId ?? null,
      (a.detail ?? "").slice(0, 300),
      (a.ip ?? "").slice(0, 64),
      (a.userAgent ?? "").slice(0, 300),
    ],
  );
}

// ---------- the trust panel ----------

export type TrustTone = "calm" | "watch" | "look";

export interface TrustRow {
  user_id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  contact_copies: number;
  contact_views: number;
  exports: number;
  document_opens: number;
  after_hours_opens: number;
  contact_changes: number;
  dead_after_approval: number;
  canaries_touched: number;
  mass_views: number;
  score: number;
  tone: TrustTone;
}

/** Weights: what a leak looks like, not what a busy rep looks like. Copies are normal; changes and canaries are not. */
export function trustScore(r: Omit<TrustRow, "score" | "tone">): {
  score: number;
  tone: TrustTone;
} {
  const score =
    r.canaries_touched * 50 +
    r.contact_changes * 15 +
    r.dead_after_approval * 12 +
    r.exports * 10 +
    r.after_hours_opens * 4 +
    r.mass_views * 3 +
    Math.max(0, r.contact_copies - 40) +
    Math.max(0, r.document_opens - 60) * 0.5;
  return { score: Math.round(score), tone: score >= 50 ? "look" : score >= 20 ? "watch" : "calm" };
}

export async function trustPanel(q: Db, days = 30): Promise<TrustRow[]> {
  const { rows } = await q.query<Omit<TrustRow, "score" | "tone">>(
    `select u.id as user_id, u.name, u.email, u.role, u.active,
       (select count(*)::int from access_log a where a.user_id = u.id and a.action in ('copy_contact', 'copy_phone', 'copy_email') and a.at > now() - ($1 || ' days')::interval) as contact_copies,
       (select count(*)::int from access_log a where a.user_id = u.id and a.action = 'view_contact' and a.at > now() - ($1 || ' days')::interval) as contact_views,
       (select count(*)::int from access_log a where a.user_id = u.id and a.action in ('export', 'backup') and a.at > now() - ($1 || ' days')::interval) as exports,
       (select count(*)::int from document_views v where v.viewer_user_id = u.id and v.at > now() - ($1 || ' days')::interval) as document_opens,
       (select count(*)::int from document_views v where v.viewer_user_id = u.id and v.at > now() - ($1 || ' days')::interval
          and extract(hour from v.at at time zone coalesce(u.timezone, 'UTC')) not between 7 and 20) as after_hours_opens,
       (select count(*)::int from access_log a where a.user_id = u.id and a.action = 'contact_changed' and a.at > now() - ($1 || ' days')::interval) as contact_changes,
       (select count(*)::int from deals d where d.user_id = u.id and d.outcome in ('dead', 'lost') and d.closed_at > now() - ($1 || ' days')::interval
          and exists (select 1 from submissions s where s.deal_id = d.id and s.status in ('approved', 'revised') and s.responded_at > d.closed_at - interval '3 days')) as dead_after_approval,
       (select count(*)::int from access_log a join clients c on c.id = a.client_id where a.user_id = u.id and c.is_canary and a.at > now() - ($1 || ' days')::interval) as canaries_touched,
       (select count(*)::int from access_log a where a.user_id = u.id and a.action = 'mass_view' and a.at > now() - ($1 || ' days')::interval) as mass_views
       from app_users u
      where u.role in ('rep', 'ops', 'manager') and (u.active or u.offboarded_at > now() - ($1 || ' days')::interval)
      order by u.active desc, u.name`,
    [String(days)],
  );
  return rows
    .map((r) => ({ ...r, ...trustScore(r) }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

// ---------- the leak tracer ----------

export interface Exposure {
  client_id: string;
  business_name: string;
  is_canary: boolean;
  /** Everyone who viewed, copied or changed the contact details, most recent first. */
  people: {
    user_id: string;
    name: string;
    email: string;
    actions: number;
    copies: number;
    last_at: string;
    owner: boolean;
  }[];
  /** Everyone who opened a document of theirs. */
  document_opens: { user_id: string | null; name: string | null; opens: number; last_at: string }[];
  /** Every lender the file went to, and when. */
  lenders: {
    funder_id: string;
    name: string;
    sent_on: string;
    status: string;
    via: string | null;
  }[];
  /** Expiring links handed to outsiders. */
  links: {
    lender_name: string | null;
    created_by_name: string | null;
    created_at: string;
    downloads: number;
  }[];
}

/** "The merchant got a backdoor call": everyone and every lender who had this file. Managers only (RLS on the log). */
export async function exposureReport(q: Db, clientId: string): Promise<Exposure> {
  const head = await q.query<{ business_name: string; is_canary: boolean; user_id: string }>(
    "select business_name, is_canary, user_id from clients where id = $1",
    [clientId],
  );
  const c = head.rows[0];
  if (!c) throw new UserError("Merchant not found");
  const people = await q.query<Exposure["people"][number]>(
    `select a.user_id, u.name, u.email, count(*)::int as actions,
            count(*) filter (where a.action in ('copy_contact', 'copy_phone', 'copy_email'))::int as copies,
            max(a.at)::text as last_at, bool_or(a.user_id = $2) as owner
       from access_log a join app_users u on u.id = a.user_id
      where a.client_id = $1 group by a.user_id, u.name, u.email order by max(a.at) desc`,
    [clientId, c.user_id],
  );
  const opens = await q.query<Exposure["document_opens"][number]>(
    `select v.viewer_user_id as user_id, u.name, count(*)::int as opens, max(v.at)::text as last_at
       from document_views v join documents d on d.id = v.document_id left join app_users u on u.id = v.viewer_user_id
      where d.client_id = $1 and v.action in ('view', 'download', 'lender_download') group by v.viewer_user_id, u.name order by max(v.at) desc`,
    [clientId],
  );
  const lenders = await q.query<Exposure["lenders"][number]>(
    `select s.funder_id, fu.name, s.sent_on::text as sent_on, s.status, s.sent_via as via
       from submissions s join funders fu on fu.id = s.funder_id where s.client_id = $1 order by s.sent_on desc`,
    [clientId],
  );
  const links = await q.query<Exposure["links"][number]>(
    `select fu.name as lender_name, u.name as created_by_name, l.created_at::text as created_at, l.downloads
       from document_links l join documents d on d.id = l.document_id
       left join funders fu on fu.id = l.lender_id left join app_users u on u.id = l.created_by
      where d.client_id = $1 order by l.created_at desc`,
    [clientId],
  );
  return {
    client_id: clientId,
    business_name: c.business_name,
    is_canary: c.is_canary,
    people: people.rows,
    document_opens: opens.rows,
    lenders: lenders.rows,
    links: links.rows,
  };
}

// ---------- one person's history ----------

export interface AccessLine {
  at: string;
  action: string;
  business_name: string | null;
  detail: string;
  ip: string;
}

export async function accessHistory(
  q: Db,
  userId: string,
  days = 30,
  limit = 500,
): Promise<AccessLine[]> {
  const { rows } = await q.query<AccessLine>(
    `select a.at::text as at, a.action, c.business_name, a.detail, a.ip
       from access_log a left join clients c on c.id = a.client_id
      where a.user_id = $1 and a.at > now() - ($2 || ' days')::interval order by a.at desc limit $3`,
    [userId, String(days), limit],
  );
  return rows;
}

// ---------- team + offboarding ----------

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: string;
  active: boolean;
  last_login_at: string | null;
  gmail_connected: boolean;
  clients: number;
  open_deals: number;
  offboarded_at: string | null;
}

export async function listTeam(q: Db): Promise<TeamMember[]> {
  const { rows } = await q.query<TeamMember>(
    `select u.id, u.email, u.name, u.role, u.active, u.last_login_at::text as last_login_at, u.offboarded_at::text as offboarded_at,
            exists (select 1 from mailboxes m where m.user_id = u.id and m.kind = 'gmail' and m.active) as gmail_connected,
            (select count(*)::int from clients c where c.user_id = u.id and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)) as clients,
            (select count(*)::int from deals d where d.user_id = u.id and d.outcome = 'open') as open_deals
       from app_users u order by u.active desc, u.role, u.name`,
  );
  return rows;
}

export interface OffboardReport {
  user: string;
  to: string;
  clients_moved: number;
  deals_moved: number;
  documents_moved: number;
  enrollments_moved: number;
  last_30_days: Record<string, number>;
}

export async function offboardUser(
  q: Db,
  userId: string,
  reassignTo: string,
): Promise<OffboardReport> {
  const { rows } = await q.query<{ r: OffboardReport }>("select offboard_user($1, $2) as r", [
    userId,
    reassignTo,
  ]);
  const r = rows[0]?.r;
  if (!r) throw new UserError("Offboarding returned nothing");
  return r;
}

export async function createCanary(
  q: Db,
  a: { repId: string; business: string; contact: string; phone: string; email: string },
): Promise<string> {
  const { rows } = await q.query<{ id: string }>("select create_canary($1, $2, $3, $4, $5) as id", [
    a.repId,
    a.business,
    a.contact,
    a.phone,
    a.email,
  ]);
  return rows[0]!.id;
}

// ---------- backdoor reports and the per-lender score (plan §6.13; audit S2-12) ----------

/**
 * "The merchant got a backdoor call": the exposure of that moment is kept, once per merchant per day, and every lender
 * the file had been sent to carries the report. Managers only (the table's policy).
 */
export async function recordBackdoorReport(
  q: Db,
  a: { clientId: string; reportedBy: string; exposure: Exposure; note?: string },
): Promise<void> {
  await q.query(
    `insert into backdoor_reports (client_id, reported_by, note, exposure, lender_ids)
     values ($1, $2, $3, $4::jsonb, $5::uuid[])
     on conflict (client_id, reported_on) do update
       set exposure = excluded.exposure, lender_ids = excluded.lender_ids,
           note = case when excluded.note <> '' then excluded.note else backdoor_reports.note end`,
    [
      a.clientId,
      a.reportedBy,
      (a.note ?? "").slice(0, 500),
      JSON.stringify(a.exposure),
      [...new Set(a.exposure.lenders.map((l) => l.funder_id))],
    ],
  );
}

export interface BackdoorScore {
  funder_id: string;
  name: string;
  /** Distinct merchants whose file went to this lender. */
  files_sent: number;
  /** Backdoor reports on merchants this lender had. */
  reports: number;
  /** Reports per hundred files sent; null until a file was sent. */
  score: number | null;
}

/** Every lender with its backdoor score, worst first. The number to read before adding a lender to a shotgun. */
export async function backdoorScores(q: Db): Promise<BackdoorScore[]> {
  const { rows } = await q.query<Omit<BackdoorScore, "score">>(
    `select fu.id as funder_id, fu.name,
            (select count(distinct s.client_id)::int from submissions s where s.funder_id = fu.id) as files_sent,
            (select count(*)::int from backdoor_reports r where fu.id = any(r.lender_ids)) as reports
       from funders fu where fu.active order by fu.name`,
  );
  return rows
    .map((r) => ({
      ...r,
      score: r.files_sent > 0 ? Math.round((1000 * r.reports) / r.files_sent) / 10 : null,
    }))
    .sort(
      (a, b) =>
        (b.score ?? -1) - (a.score ?? -1) || b.reports - a.reports || a.name.localeCompare(b.name),
    );
}

/** The person accepts the anti-backdoor policy; returns when (the first time stays). */
export async function acceptPolicy(q: Db): Promise<string> {
  const { rows } = await q.query<{ at: string }>("select accept_policy()::text as at");
  return rows[0]?.at ?? "";
}
