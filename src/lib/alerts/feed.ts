import type { Db } from "../db";

/**
 * The person's alert feed (0500 user_alerts): what the automations wrote for them, newest first. The hourly job
 * emails the unsent ones; this is the page. Reads and marks run as the person, so RLS keeps it to their own rows.
 */
export interface AlertFeedRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string;
  created_at: string;
  read_at: string | null;
  business_name: string | null;
}

export const ALERT_KIND_LABELS: Record<string, string> = {
  approval_landed: "Approval",
  funding_proposed: "Funding to confirm",
  chase_draft: "Chase draft",
  stale_deal: "Sitting too long",
  behind_pace: "Pace",
  kickback: "Kicked back",
  late_payout: "Lender payout late",
  registration: "Registration",
  trust: "Trust check",
  application_signed: "Application signed",
  renewal_eligible: "Renewal",
  ask_manager: "Question for you",
  template_paused: "Template paused",
  bounce_spike: "Bounce spike",
};

export async function listAlerts(q: Db, limit = 100): Promise<AlertFeedRow[]> {
  const { rows } = await q.query<AlertFeedRow>(
    `select a.id::text as id, a.kind, a.title, a.body, a.href,
            to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
            to_char(a.read_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as read_at,
            c.business_name
       from user_alerts a left join clients c on c.id = a.client_id
      where a.user_id = app.current_user_id()
      order by a.read_at is not null, a.created_at desc
      limit $1`,
    [limit],
  );
  return rows;
}

/** Marks the given alerts read, or every unread one when no ids are given. Returns how many changed. */
export async function markAlertsRead(q: Db, ids?: readonly string[]): Promise<number> {
  const { rowCount } = ids
    ? await q.query(
        "update user_alerts set read_at = now() where user_id = app.current_user_id() and read_at is null and id = any($1::bigint[])",
        [ids],
      )
    : await q.query(
        "update user_alerts set read_at = now() where user_id = app.current_user_id() and read_at is null",
      );
  return rowCount ?? 0;
}
