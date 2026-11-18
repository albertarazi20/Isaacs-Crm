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
  application_signed: "Application signed",
  brought_in: "Brought in",
  file_complete: "File complete",
  template_paused: "Template paused",
  bounce_spike: "Bounce spike",
  offer_opened: "Offer opened",
  offer_accepted: "Offer accepted",
  offer_doc_rejected: "Offer document failed",
  // the security audit log (0573): sent to managers, each links to Settings > Security
  security_new_device: "New device",
  security_export: "Export",
  security_failed_signins: "Failed sign-ins",
};

/**
 * The kinds the system writes today. Alerts left over from the removed features (deals, lenders, money) stay in the
 * table but are not shown or counted.
 */
export const LIVE_ALERT_KINDS: readonly string[] = Object.keys(ALERT_KIND_LABELS);

/** How many live alerts the person has not read: the number on the Alerts badge. */
export async function unreadAlertCount(q: Db): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    "select count(*)::int as n from user_alerts where user_id = app.current_user_id() and read_at is null and kind = any($1::text[])",
    [LIVE_ALERT_KINDS],
  );
  return rows[0]?.n ?? 0;
}

export async function listAlerts(q: Db, limit = 100): Promise<AlertFeedRow[]> {
  const { rows } = await q.query<AlertFeedRow>(
    `select a.id::text as id, a.kind, a.title, a.body, a.href,
            to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
            to_char(a.read_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as read_at,
            c.business_name
       from user_alerts a left join clients c on c.id = a.client_id
      where a.user_id = app.current_user_id() and a.kind = any($2::text[])
      order by a.read_at is not null, a.created_at desc
      limit $1`,
    [limit, LIVE_ALERT_KINDS],
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
