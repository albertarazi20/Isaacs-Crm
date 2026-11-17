/**
 * The alert feed by email. The alerts themselves are written where the thing happens (a merchant replies, an
 * application is signed) through app.alert(), whose dedupe key makes a thing alert once. This file is the drain: every
 * person with unsent rows gets one email bundling all of them, at most once an hour, claimed inside the transaction
 * that sends so two overlapping runs cannot both send and a failed send is retried. Pages read the same rows; the
 * email is the copy that reaches a phone.
 */
import type { DbAccess } from "../db";
import type { DigestSender } from "./reminders";

export interface AlertRunSummary {
  users: number;
  sent: number;
  skipped: number;
  failed: number;
}

// ---------- the email ----------

export interface AlertRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string;
  created_at: Date;
}

const esc = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** One email for everything unsent: the first title is the subject when there is one thing, a count otherwise. */
export function buildAlertEmail(
  rows: readonly AlertRow[],
  appUrl: string,
): { subject: string; text: string; html: string } {
  const first = rows[0];
  const subject =
    rows.length === 1 && first
      ? first.title
      : `${rows.length} things need you — ${first?.title ?? ""}`.slice(0, 150);
  const lines = rows.map((r) => {
    const href = r.href ? `${appUrl}${r.href.startsWith("/") ? "" : "/"}${r.href}` : `${appUrl}/`;
    return {
      text: `• ${r.title}${r.body ? `\n  ${r.body}` : ""}\n  ${href}`,
      html: `<li><a href="${esc(href)}"><strong>${esc(r.title)}</strong></a>${r.body ? `<br><small>${esc(r.body)}</small>` : ""}</li>`,
    };
  });
  return {
    subject,
    text: `${lines.map((l) => l.text).join("\n")}\n\nOpen the CRM: ${appUrl}/\n`,
    html: `<div style="font-family:system-ui,sans-serif"><ul>${lines.map((l) => l.html).join("")}</ul><p><a href="${esc(appUrl)}/">Open the CRM</a></p></div>`,
  };
}

interface UserRow {
  id: string;
  email: string;
  to_email: string;
}

/** Thrown inside the transaction when nothing needs sending, so the claim rolls back cleanly. */
class NothingToSend extends Error {}

/**
 * Drain: one email per person with unsent alerts, bundling every kind, never more than one an hour.
 * Rows are locked (`for update skip locked`) and stamped in the same transaction as the send: a failed send rolls
 * the stamp back for the next run, and an overlapping run finds the rows locked and sends nothing.
 */
export async function runUserAlerts(args: {
  db: DbAccess;
  now: Date;
  appUrl: string;
  send: DigestSender;
  /** Who may still receive email (see runReminders). Default: everyone. */
  allowed?: (loginEmail: string) => boolean;
}): Promise<AlertRunSummary> {
  const users = await args.db.withSystem(
    async (q) =>
      (
        await q.query<UserRow>(
          `select u.id, u.email, coalesce(u.notify_email, u.email) as to_email
             from app_users u
            where u.active and u.digest_enabled
              and exists (select 1 from user_alerts a where a.user_id = u.id and a.emailed_at is null)
            order by u.created_at`,
        )
      ).rows,
  );
  const summary: AlertRunSummary = {
    users: users.length,
    sent: 0,
    skipped: 0,
    failed: 0,
  };
  for (const u of users) {
    if (args.allowed && !args.allowed(u.email)) {
      summary.skipped += 1;
      continue;
    }
    try {
      await args.db.withSystem(async (q) => {
        const recent = await q.query(
          "select 1 from user_alerts where user_id = $1 and emailed_at > $2::timestamptz - interval '1 hour' limit 1",
          [u.id, args.now.toISOString()],
        );
        if ((recent.rowCount ?? 0) > 0) throw new NothingToSend();
        const { rows } = await q.query<AlertRow>(
          `select id::text as id, kind, title, body, href, created_at from user_alerts
            where user_id = $1 and emailed_at is null order by created_at, id for update skip locked`,
          [u.id],
        );
        if (rows.length === 0) throw new NothingToSend();
        await args.send(u.to_email, buildAlertEmail(rows, args.appUrl));
        await q.query("update user_alerts set emailed_at = $2 where id = any($1::bigint[])", [
          rows.map((r) => r.id),
          args.now.toISOString(),
        ]);
      });
      summary.sent += 1;
    } catch (e) {
      if (e instanceof NothingToSend) summary.skipped += 1;
      else {
        summary.failed += 1;
        console.error(`alert email failed for user ${u.id}:`, e instanceof Error ? e.message : e);
      }
    }
  }
  return summary;
}
