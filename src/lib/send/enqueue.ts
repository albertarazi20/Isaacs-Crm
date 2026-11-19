import type { Db } from "../db";
import type { Lane } from "./rules";
import { nextSendTime } from "./rules";

export interface EnqueueInput {
  clientId: string;
  lane: Lane;
  /** 'bucket:<id>:step:<n>' | 'blast:<id>' | 'intake' | 'manual' */
  source: string;
  subject: string;
  text: string;
  /** Send now (intake, reply) or at the merchant's next local window (sequence, blast). */
  when?: "now" | "window";
  /** An exact moment to send (a bucket's daily reminder at the shop's time): used as it is, with no window applied. */
  at?: Date;
  /** Drop it if it has not gone by then (a stale reminder must not fire a week late). */
  expiresInHours?: number;
  /** The template it came from, for the per-template scores and the bounce-spike pause (S1-7). */
  templateId?: string | null;
  /** A designed HTML part (an offer email); the text part is always sent too. */
  html?: string | null;
}

export type EnqueueResult =
  | { queued: true; outboxId: string; notBefore: string }
  /** duplicate: the same automated email (merchant and source) is already pending, or the blast already went today. */
  | { queued: false; reason: "no_address" | "opted_out" | "suppressed" | "dnc" | "duplicate" }
  /** The row was written but the database cancelled it as it landed (a handed-off merchant gets no automated mail). */
  | { queued: false; reason: "brought_in" | "cancelled"; outboxId: string };

interface ClientBits {
  user_id: string;
  email: string;
  email_opt_out: boolean;
  contact_status: string;
  timezone: string;
  suppressed: boolean;
}

interface Window {
  send_window_start: number;
  send_window_end: number;
  send_on_weekends: boolean;
  send_on_holidays: boolean;
}

/**
 * Put one email on the outbox for a merchant. Checks that cannot change by send time are done here (address,
 * opt-out, suppression, do-not-contact); the ones that can (the cap, the per-merchant limit, a reply that
 * arrived) are checked by the worker right before it sends. The result is read from the row as the database stored
 * it: a second pending copy of the same sequence step or blast is not written (0543), and a row the database
 * cancelled on the way in is not reported as queued.
 */
export async function enqueueEmail(
  q: Db,
  input: EnqueueInput,
  now = new Date(),
): Promise<EnqueueResult> {
  const { rows } = await q.query<ClientBits>(
    `select c.user_id, c.email, c.email_opt_out, c.contact_status, app.client_timezone(c) as timezone,
            app.is_suppressed('email', c.email) as suppressed
       from clients c where c.id = $1`,
    [input.clientId],
  );
  const c = rows[0];
  if (!c || c.email.trim() === "") return { queued: false, reason: "no_address" };
  if (c.contact_status === "dnc" || c.contact_status === "no_email")
    return { queued: false, reason: "dnc" };
  if (c.email_opt_out) return { queued: false, reason: "opted_out" };
  if (c.suppressed) return { queued: false, reason: "suppressed" };

  let notBefore = input.at ?? now;
  if (
    !input.at &&
    (input.when ?? (input.lane === "sequence" || input.lane === "blast" ? "window" : "now")) ===
      "window"
  ) {
    const w = (
      await q.query<Window>(
        "select send_window_start, send_window_end, send_on_weekends, send_on_holidays from shop_settings",
      )
    ).rows[0];
    notBefore = nextSendTime(now, {
      timezone: c.timezone,
      startHour: w?.send_window_start ?? 9,
      endHour: w?.send_window_end ?? 11,
      weekends: w?.send_on_weekends ?? false,
      holidays: w?.send_on_holidays ?? false,
    });
  }
  const expires = input.expiresInHours
    ? new Date(notBefore.getTime() + input.expiresInHours * 3_600_000)
    : null;
  const ins = await q.query<{ id: string; status: string; skip_reason: string | null }>(
    `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, not_before, expires_at, template_id, html_body)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict do nothing
     returning id, status, skip_reason`,
    [
      c.user_id,
      input.clientId,
      input.lane,
      input.source,
      c.email.trim(),
      input.subject,
      input.text,
      notBefore.toISOString(),
      expires?.toISOString() ?? null,
      input.templateId ?? null,
      input.html ?? null,
    ],
  );
  const row = ins.rows[0];
  if (!row) return { queued: false, reason: "duplicate" };
  if (row.status !== "queued")
    return {
      queued: false,
      reason: row.skip_reason === "brought_in" ? "brought_in" : "cancelled",
      outboxId: row.id,
    };
  return { queued: true, outboxId: row.id, notBefore: notBefore.toISOString() };
}

/** Cancel every queued automated email to a merchant (a reply came in, docs arrived, the merchant moved on). */
export async function cancelQueued(
  q: Db,
  clientId: string,
  reason: string,
  sourcePrefix = "",
): Promise<number> {
  const res = await q.query(
    `update outbox set status = 'cancelled', skip_reason = $2
      where client_id = $1 and status = 'queued' and lane in ('sequence', 'blast') and source like $3`,
    [clientId, reason, `${sourcePrefix}%`],
  );
  return res.rowCount ?? 0;
}
