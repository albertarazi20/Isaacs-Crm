import { z } from "zod";
import type { Db, DbAccess } from "../db";
import { recordAudit } from "../system/audit";

/**
 * "Stop emails for good" (migration 0580). The work is in two database functions, because it touches rows a rep's
 * own session cannot reach (the suppression list, mail queued under another user): public.stop_merchant_emails (the
 * rep's own merchant, or a manager's any) and public.resume_merchant_emails (managers only). This file is the thin
 * side: the input, the reads the screens need, and the audit line.
 *
 * What a stop does, in one transaction: suppress the address (reason 'manual') and set clients.email_opt_out, so every
 * automated lane refuses the merchant (approvals, bucket sequences, nudges, the intake welcome email, blasts); stop the
 * approval sequence (note 'manual_stop'); cancel their queued automated mail; stop their bucket enrolment; write a
 * timeline note. Sent mail is never touched. The rep's own one-off mail through the CRM (the offer email, lane
 * 'reply') is not cancelled, but the worker still refuses it while the opt-out stands.
 */

export const stopEmailsSchema = z.object({
  clientId: z.string().uuid("That merchant no longer exists"),
});

/** What the database function reports. */
export interface StopResult {
  /** The merchant was already stopped by hand: nothing changed. */
  already: boolean;
  /** They had unsubscribed (or opted out) before: no flag is set, so turning emails on can never undo their wish. */
  wasOptedOut: boolean;
  /** Queued automated emails taken back. */
  cancelled: number;
  /** Bucket enrolments ended. */
  enrollments: number;
  /** Approval sequences stopped. */
  approvals: number;
}

interface StopRaw {
  already: boolean;
  was_opted_out: boolean;
  cancelled: number;
  enrollments: number;
  approvals: number;
}

export interface Who {
  userId: string;
  email: string;
}

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/** Whether a merchant's emails are stopped by hand, since when and by whom (readable by the merchant's rep). */
export interface EmailsStopped {
  at: string;
  by: string;
}

export async function emailsStoppedFor(q: Db, clientId: string): Promise<EmailsStopped | null> {
  const { rows } = await q.query<{ at: string; by: string }>(
    `select c.emails_stopped_at::text as at, coalesce(nullif(btrim(u.name), ''), u.email, '') as by
       from clients c left join app_users u on u.id = c.emails_stopped_by
      where c.id = $1 and c.emails_stopped_at is not null`,
    [clientId],
  );
  return rows[0] ?? null;
}

/**
 * Stop every automated email to one merchant, for good. A rep can only stop their own merchants (the database
 * function raises "no longer exists" for anyone else's), a manager any. Writes the audit line after the commit; the
 * audit never throws into the request.
 */
export async function stopEmailsForGood(
  db: DbAccess,
  who: Who,
  clientId: string,
  meta: RequestMeta = {},
): Promise<StopResult> {
  const raw = await db.withUser(who.userId, async (q) => {
    const { rows } = await q.query<{ r: StopRaw }>("select public.stop_merchant_emails($1) as r", [
      clientId,
    ]);
    const r = rows[0]?.r;
    if (!r) throw new Error("stop_merchant_emails returned nothing");
    return r;
  });
  const result: StopResult = {
    already: raw.already,
    wasOptedOut: raw.was_opted_out,
    cancelled: raw.cancelled,
    enrollments: raw.enrollments,
    approvals: raw.approvals,
  };
  if (!result.already)
    await recordAudit(
      {
        kind: "merchant_emails_stopped",
        userId: who.userId,
        email: who.email,
        clientId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        detail: {
          cancelled: result.cancelled,
          enrollments_stopped: result.enrollments,
          approvals_stopped: result.approvals,
          already_opted_out: result.wasOptedOut,
        },
      },
      db,
    );
  return result;
}

/**
 * Turn the emails back on (managers only: the database function checks). Clears the stop and nothing else: the
 * approval sequence stays stopped until someone presses "Start the emails", the bucket enrolment stays stopped, nothing
 * is queued. Refused if the merchant also unsubscribed, replied stop or complained.
 */
export async function turnEmailsBackOn(
  db: DbAccess,
  who: Who,
  clientId: string,
  meta: RequestMeta = {},
): Promise<{ changed: boolean }> {
  const raw = await db.withUser(who.userId, async (q) => {
    const { rows } = await q.query<{ r: { changed: boolean } }>(
      "select public.resume_merchant_emails($1) as r",
      [clientId],
    );
    return rows[0]?.r ?? { changed: false };
  });
  if (raw.changed)
    await recordAudit(
      {
        kind: "merchant_emails_resumed",
        userId: who.userId,
        email: who.email,
        clientId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      db,
    );
  return { changed: raw.changed };
}
