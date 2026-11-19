import type { Db } from "../db";
import { greetingName, tidy } from "../mca/templates";
import { merchantOwnWords, stripMerchantText } from "../messaging/claims";
import { nextSendTime, partsIn, type WindowInput } from "../send/rules";
import { approvalClaims, fillApprovalEmail, htmlToText, type ApprovalValues } from "./html";
import { offerMoney } from "./words";

/**
 * The approval emails, one approval at a time. Step 1 goes when the approval is marked (inside the day, merchant's
 * time); every later step goes `delay_hours` after the step before it was actually sent — the outbox's sent_at is the
 * clock, so a step that waited for the morning or for Gmail pushes the rest back with it. Nothing is queued ahead:
 * a step is put on the outbox only when it is due, so a reply, a pitch or a changed delay always wins.
 */

/** Why the emails stopped for good (until a rep presses Resume). From app.approval_halt and the outbox. */
export const STOP_NOTES = [
  "replied",
  "expired",
  "trashed",
  "dnc",
  "opted_out",
  "no_email",
  "bounced",
  "suppressed",
  "send_failed",
  /** A person pressed "Stop emails for good" (src/lib/approvals/hardStop.ts). */
  "manual_stop",
] as const;
export type StopNote = (typeof STOP_NOTES)[number];
const STOPS = new Set<string>(STOP_NOTES);

export type AdvanceResult =
  | { kind: "queued"; step: number; notBefore: string }
  | { kind: "waiting"; note: string; step: number | null; at: string | null }
  | { kind: "stopped"; note: string }
  | { kind: "finished" }
  | { kind: "idle" };

export interface ApprovalStepRow {
  step: number;
  subject: string;
  html: string;
  delay_hours: number;
}

interface Row {
  id: string;
  client_id: string;
  /** The merchant's rep now: the sender, and whose name and phone go in. */
  owner_id: string;
  amount_cents: string;
  hold_until: string | null;
  status: string;
  emails: string;
  emails_since: Date;
  /** When the rep sent step 1 themselves (nothing was on the outbox for it), else null. */
  first_sent_at: Date | null;
  halt: string | null;
  /** The merchant accepted this approval's offer: no more follow-ups. */
  accepted: boolean;
  business_name: string;
  contact_name: string;
  dba: string;
  email: string;
  state: string;
  unsubscribe_token: string;
  tz: string;
  rep_name: string;
  rep_email: string;
  rep_phone: string;
  approval_emails_on: boolean;
  approval_window_start: number;
  approval_window_end: number;
  approval_weekends: boolean;
  send_on_holidays: boolean;
}

interface SentRow {
  step: number;
  status: string;
  sent_at: Date | null;
  skip_reason: string | null;
  created_at: Date;
}

const HOUR = 3_600_000;

export const sourceFor = (approvalId: string, step: number) =>
  `approval:${approvalId}:step:${step}`;

/** "2026-11-21" → "Friday, November 21". */
export function expiryWords(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/**
 * The offer date an email quotes when the rep typed no hold date: a week after the day the email goes out (the
 * merchant's own day), moved forward to the Monday when that lands on a Saturday or Sunday.
 */
export function weekAfterSend(sendAt: Date, tz: string): string {
  const day = partsIn(tz, sendAt).date;
  const d = new Date(new Date(`${day}T00:00:00Z`).getTime() + 7 * 86_400_000);
  if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The values one merchant's email is filled with; empty means "we don't know" and holds the email. */
export function approvalValues(r: {
  contact_name: string;
  business_name: string;
  amount_cents: number;
  hold_until: string | null;
  rep_name: string;
  rep_phone: string;
  rep_email: string;
  unsubscribe_url: string;
}): ApprovalValues {
  return {
    first_name: tidy(greetingName(r.contact_name)),
    business_name: r.business_name.trim(),
    offer_amount: r.amount_cents > 0 ? offerMoney(r.amount_cents) : "",
    offer_expiry: r.hold_until ? expiryWords(r.hold_until) : "",
    rep_name: tidy(r.rep_name.trim()),
    rep_phone: r.rep_phone.trim(),
    rep_email: r.rep_email.trim(),
    unsubscribe_link: r.unsubscribe_url,
  };
}

/** Stop an approval's emails and take back the one waiting on the outbox. */
export async function stopApprovalEmails(
  q: Db,
  approvalId: string,
  emails: "stopped" | "paused" | "finished",
  note: string,
): Promise<void> {
  await q.query(
    `update approvals set emails = $2, emails_note = $3, next_step = null, next_email_at = null where id = $1`,
    [approvalId, emails, note],
  );
  await q.query(
    `update outbox set status = 'cancelled', skip_reason = $2
      where lane = 'approval' and status = 'queued' and source like $1`,
    [`approval:${approvalId}:step:%`, emails === "paused" ? "paused" : note || emails],
  );
}

async function wait(
  q: Db,
  id: string,
  note: string,
  step: number | null,
  at: Date | null,
): Promise<AdvanceResult> {
  await q.query(
    "update approvals set emails_note = $2, next_step = $3, next_email_at = $4 where id = $1",
    [id, note, step, at?.toISOString() ?? null],
  );
  return { kind: "waiting", note, step, at: at?.toISOString() ?? null };
}

/**
 * Move one approval along: stop it if it must stop, queue the next step if it is due, or record what it waits for.
 * Safe to run any number of times (the row is locked, and a step can be on the outbox only once). Runs on the owner
 * connection (src/lib/system/approvals.ts): it must see every step already sent, whoever's mailbox sent it.
 */
export async function advanceApproval(
  q: Db,
  approvalId: string,
  opts: { now: Date; appUrl: string; spread?: number },
): Promise<AdvanceResult> {
  const { rows } = await q.query<Row>(
    `select a.id, a.client_id, c.user_id as owner_id, a.amount_cents, a.hold_until::text as hold_until, a.status, a.emails,
            a.emails_since, a.first_sent_at, app.approval_halt(a.id) as halt,
            exists (select 1 from merchant_offers o where o.approval_id = a.id and o.status = 'accepted') as accepted,
            c.business_name, c.contact_name, c.dba, c.email, c.state, c.unsubscribe_token,
            app.client_timezone(c) as tz,
            coalesce(u.name, '') as rep_name, coalesce(u.email, '') as rep_email, coalesce(u.phone, '') as rep_phone,
            s.approval_emails_on, s.approval_window_start, s.approval_window_end, s.approval_weekends,
            s.send_on_holidays
       from approvals a
       join clients c on c.id = a.client_id
       left join app_users u on u.id = c.user_id
       cross join shop_settings s
      where a.id = $1
      for update of a`,
    [approvalId],
  );
  const a = rows[0];
  if (!a || a.status !== "open" || a.emails !== "running") return { kind: "idle" };
  if (a.halt && STOPS.has(a.halt)) {
    await stopApprovalEmails(q, a.id, "stopped", a.halt);
    return { kind: "stopped", note: a.halt };
  }
  if (a.accepted) {
    await stopApprovalEmails(q, a.id, "stopped", "offer_accepted");
    return { kind: "stopped", note: "offer_accepted" };
  }
  if (!a.approval_emails_on) return wait(q, a.id, "turned_off", null, null);

  const steps = (
    await q.query<ApprovalStepRow>(
      "select step, subject, html, delay_hours from approval_emails order by step",
    )
  ).rows;
  const sent = (
    await q.query<SentRow>(
      `select split_part(source, ':', 4)::int as step, status, sent_at, skip_reason, created_at
         from outbox where lane = 'approval' and source like $1
        order by created_at`,
      [`approval:${a.id}:step:%`],
    )
  ).rows;
  // one already on its way: nothing to decide until it has gone
  if (sent.some((s) => s.status === "queued" || s.status === "sending")) return { kind: "idle" };
  const since = a.emails_since.getTime();
  const recent = sent.filter((s) => s.created_at.getTime() >= since);
  const refused = recent.find(
    (s) => s.status === "skipped" && s.skip_reason && STOPS.has(s.skip_reason),
  );
  if (refused?.skip_reason) {
    await stopApprovalEmails(q, a.id, "stopped", refused.skip_reason);
    return { kind: "stopped", note: refused.skip_reason };
  }
  if (recent.some((s) => s.status === "failed" || s.status === "skipped")) {
    await stopApprovalEmails(q, a.id, "stopped", "send_failed");
    return { kind: "stopped", note: "send_failed" };
  }

  const done = sent.filter((s) => s.status === "sent" && s.sent_at);
  // the first email the rep sent from their own mailbox: step 1 counts as sent at that moment (it was never on the
  // outbox, so it is the one step the outbox cannot tell us about). A step 1 the outbox knows about wins.
  if (a.first_sent_at && !sent.some((s) => s.step === 1 && s.status === "sent"))
    done.push({
      step: 1,
      status: "sent",
      sent_at: a.first_sent_at,
      skip_reason: null,
      created_at: a.first_sent_at,
    });
  const last = done.reduce<SentRow | null>((m, s) => (m && m.step >= s.step ? m : s), null);
  const next = steps.find((s) => s.step > (last?.step ?? 0));
  if (!next) {
    await stopApprovalEmails(q, a.id, "finished", "");
    return { kind: "finished" };
  }

  // the first email is the rep's own, sent from their mailbox and recorded by hand: the system only sends follow-ups
  if (next.step === 1) return wait(q, a.id, "first_by_rep", 1, null);

  const window: WindowInput = {
    timezone: a.tz,
    startHour: a.approval_window_start,
    endHour: a.approval_window_end,
    weekends: a.approval_weekends,
    holidays: a.send_on_holidays,
  };
  const now = opts.now;
  const due =
    last?.sent_at && next.step > 1
      ? new Date(last.sent_at.getTime() + next.delay_hours * HOUR)
      : now;
  if (due.getTime() > now.getTime())
    return wait(q, a.id, "", next.step, nextSendTime(due, window, 0));
  if (next.html.trim() === "" || next.subject.trim() === "")
    return wait(q, a.id, "no_design", next.step, null);

  // a step due overnight goes when the day starts (not spread across it: these are one-to-one emails)
  const notBefore = nextSendTime(now, window, opts.spread ?? 0);
  const filled = fillApprovalEmail(
    { subject: next.subject, html: next.html },
    approvalValues({
      contact_name: a.contact_name,
      business_name: a.business_name,
      amount_cents: Number(a.amount_cents),
      // the funder's date when the rep typed one; otherwise a week after this email goes out
      hold_until: a.hold_until ?? weekAfterSend(notBefore, a.tz),
      rep_name: a.rep_name,
      rep_phone: a.rep_phone,
      rep_email: a.rep_email,
      unsubscribe_url: `${opts.appUrl.replace(/\/$/, "")}/u/${a.unsubscribe_token}`,
    }),
  );
  if (filled.unfilled.length > 0)
    return wait(q, a.id, `bad_field:${filled.unfilled.join(" ")}`.slice(0, 200), next.step, null);
  if (filled.missing.length > 0)
    return wait(q, a.id, `missing:${filled.missing.join(",")}`, next.step, null);
  const text = htmlToText(filled.html);
  // the merchant's own business or contact name ("Guaranteed Roofing") is not the shop's claim: cut it out first
  const claimText = stripMerchantText(
    `${filled.subject}\n${text}`,
    merchantOwnWords({ businessName: a.business_name, contactName: a.contact_name, dba: a.dba }),
  );
  if (approvalClaims(claimText, { state: a.state }).length > 0)
    return wait(q, a.id, "claim_check", next.step, null);

  const ins = await q.query<{ id: string }>(
    `insert into outbox (user_id, client_id, lane, source, to_address, subject, text_body, html_body, not_before)
     values ($1, $2, 'approval', $3, $4, $5, $6, $7, $8)
     on conflict do nothing returning id`,
    [
      a.owner_id,
      a.client_id,
      sourceFor(a.id, next.step),
      a.email.trim(),
      filled.subject,
      text,
      filled.html,
      notBefore.toISOString(),
    ],
  );
  if (!ins.rows[0]) return { kind: "idle" };
  await q.query(
    "update approvals set emails_note = '', next_step = $2, next_email_at = $3 where id = $1",
    [a.id, next.step, notBefore.toISOString()],
  );
  return { kind: "queued", step: next.step, notBefore: notBefore.toISOString() };
}
