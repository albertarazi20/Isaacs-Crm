/**
 * Manager notifications that must not depend on a rep's mailbox: exports happened, a canary was touched. Best effort
 * over the shop's Resend sender; silent when it is not configured.
 */
import type { DbAccess } from "../db";
import { sendViaResend } from "../email/resend";
import { env } from "../env";

export async function notifyManagers(
  db: DbAccess,
  m: { subject: string; text: string },
): Promise<number> {
  const e = env();
  if (!e.RESEND_API_KEY || !e.RESEND_FROM) return 0;
  const to = await db.withSystem(
    async (q) =>
      (
        await q.query<{ email: string }>(
          "select coalesce(notify_email, email) as email from app_users where role = 'manager' and active limit 5",
        )
      ).rows,
  );
  let n = 0;
  for (const r of to) {
    try {
      await sendViaResend(
        { apiKey: e.RESEND_API_KEY, from: e.RESEND_FROM },
        {
          to: r.email,
          subject: m.subject,
          text: m.text,
          html: `<pre style="font:14px/1.5 system-ui">${m.text.replace(/</g, "&lt;")}</pre>`,
        },
      );
      n++;
    } catch {
      // the log line below is the record; the email is a courtesy
    }
  }
  return n;
}

/** An export or backup ran: write the log line (as the system, so it cannot be skipped) and tell the managers. */
export async function recordExport(
  db: DbAccess,
  a: {
    userId: string;
    email: string;
    kind: "export" | "backup";
    detail: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<void> {
  await db.withSystem((q) =>
    q.query(
      "insert into access_log (user_id, action, detail, ip, user_agent) values ($1, $2, $3, $4, $5)",
      [
        a.userId,
        a.kind,
        a.detail.slice(0, 300),
        (a.ip ?? "").slice(0, 64),
        (a.userAgent ?? "").slice(0, 300),
      ],
    ),
  );
  await notifyManagers(db, {
    subject: `${a.kind === "backup" ? "Backup" : "Export"} downloaded: ${a.detail}`,
    text: `${a.email} downloaded ${a.detail} at ${new Date().toISOString()}${a.ip ? ` from ${a.ip}` : ""}.\n\nExports are manager-only and every one is logged (Settings → Team → Trust).`,
  });
}
