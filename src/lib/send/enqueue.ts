import type { Db } from "../db";
import type { Lane } from "./rules";
import { nextSendTime } from "./rules";

export interface EnqueueInput {
  clientId: string;
  dealId?: string | null;
  lane: Lane;
  /** 'bucket:<id>:step:<n>' | 'winback:<pool>:<n>' | 'blast:<id>' | 'intake' | 'manual' */
  source: string;
  subject: string;
  text: string;
  /** Send now (intake, reply) or at the merchant's next local window (sequence, blast). */
  when?: "now" | "window";
  /** Drop it if it has not gone by then (a stale reminder must not fire a week late). */
  expiresInHours?: number;
  /** The template it came from, for the per-template scores and the bounce-spike pause (S1-7). */
  templateId?: string | null;
}

export type EnqueueResult =
  | { queued: true; outboxId: string; notBefore: string }
  | { queued: false; reason: "no_address" | "opted_out" | "suppressed" | "dnc" };

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
}

/**
 * Put one email on the outbox for a merchant. Checks that cannot change by send time are done here (address,
 * opt-out, suppression, do-not-contact); the ones that can (the cap, the per-merchant limit, a reply that
 * arrived) are checked by the worker right before it sends.
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

  let notBefore = now;
  if (
    (input.when ?? (input.lane === "sequence" || input.lane === "blast" ? "window" : "now")) ===
    "window"
  ) {
    const w = (
      await q.query<Window>(
        "select send_window_start, send_window_end, send_on_weekends from shop_settings",
      )
    ).rows[0];
    notBefore = nextSendTime(now, {
      timezone: c.timezone,
      startHour: w?.send_window_start ?? 9,
      endHour: w?.send_window_end ?? 11,
      weekends: w?.send_on_weekends ?? false,
    });
  }
  const expires = input.expiresInHours
    ? new Date(notBefore.getTime() + input.expiresInHours * 3_600_000)
    : null;
  const ins = await q.query<{ id: string }>(
    `insert into outbox (user_id, client_id, deal_id, lane, source, to_address, subject, text_body, not_before, expires_at, template_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
    [
      c.user_id,
      input.clientId,
      input.dealId ?? null,
      input.lane,
      input.source,
      c.email.trim(),
      input.subject,
      input.text,
      notBefore.toISOString(),
      expires?.toISOString() ?? null,
      input.templateId ?? null,
    ],
  );
  const id = ins.rows[0]?.id;
  if (!id) throw new Error("outbox insert returned no row");
  return { queued: true, outboxId: id, notBefore: notBefore.toISOString() };
}

/** Cancel every queued automated email to a merchant (a reply came in, docs arrived, the deal moved). */
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
