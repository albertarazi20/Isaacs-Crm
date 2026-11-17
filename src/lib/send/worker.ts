import type { Db, DbAccess } from "../db";
import { approvalClaims, hasPostalAddress, withFooter } from "../approvals/html";
import { checkClaims } from "../messaging/claims";
import {
  capAllows,
  inSendWindow,
  legalFooter,
  merchantCapAllows,
  nextSendTime,
  textToHtml,
  type Lane,
  type WindowInput,
} from "./rules";

export interface Deliverer {
  /** Send through the rep's Gmail. Returns the provider id. `html` is the designed version (approval emails). */
  gmail(
    userId: string,
    m: {
      to: string;
      subject: string;
      text: string;
      html?: string;
      headers?: Readonly<Record<string, string>>;
    },
  ): Promise<string>;
  /** Send through the shop's Resend domain. Returns the provider id. */
  resend(m: {
    to: string;
    subject: string;
    text: string;
    html: string;
    replyTo?: string;
    headers?: Readonly<Record<string, string>>;
  }): Promise<string>;
}

export interface DrainSummary {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  deferred: number;
}

interface Settings {
  shop_name: string;
  postal_address: string;
  daily_cap: number;
  reserved_for_intake: number;
  per_merchant_daily: number;
  per_merchant_weekly: number;
  automation_from: string;
  automation_reply_to_rep: boolean;
  /** The SPF / DKIM / DMARC check on the automation domain passed (S1-4). Resend sends wait until it has. */
  dns_ok: boolean;
}

interface Job {
  id: string;
  user_id: string;
  client_id: string | null;
  lane: Lane;
  source: string;
  to_address: string;
  subject: string;
  text_body: string;
  /** The designed HTML (approval emails); null: the HTML is made from the text. */
  html_body: string | null;
  expires_at: string | null;
  attempts: number;
  last_error: string | null;
  rep_email: string | null;
  gmail_address: string | null;
  gmail_ok: boolean;
  client_opt_out: boolean | null;
  client_dnc: boolean | null;
  client_trashed: boolean;
  /** The bucket enrolment this step belongs to is paused (a rep's Pause, or a merchant's "not now"). */
  enrollment_paused: boolean;
  /** A nudge after an open that something since made wrong to send (app.nudge_overtaken). */
  nudge_overtaken: boolean;
  client_state: string | null;
  suppressed: boolean;
  unsubscribe_token: string | null;
  merchant_24h: number;
  merchant_7d: number;
}

/** What the worker re-reads right before an approval email goes. */
interface ApprovalCheck {
  halt: string | null;
  owner_id: string;
  email: string;
  tz: string;
  approval_window_start: number;
  approval_window_end: number;
  approval_weekends: boolean;
  send_on_holidays: boolean;
}

const MAX_ATTEMPTS = 3;

/** The sending identity a ledger row keys on: a user's Gmail or the shop's Resend domain. Upserted, never duplicated. */
export async function mailboxFor(
  q: Db,
  kind: "gmail" | "resend",
  userId: string | null,
  address: string,
  limit: number,
): Promise<string> {
  const { rows } = await q.query<{ id: string }>(
    `insert into mailboxes (kind, user_id, address, provider_limit) values ($1, $2, $3, $4)
     on conflict (kind, address) do update set active = true returning id`,
    [kind, kind === "gmail" ? userId : null, address, limit],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("mailbox upsert returned no row");
  return id;
}

/**
 * Drain the outbox: claim due rows one at a time (skip-locked, so overlapping runs never double-send), re-check the
 * rules that can change by send time, pick the mailbox (the shop's Resend domain for automation when configured,
 * otherwise the rep's Gmail), send, and write the ledger. Runs under the owner connection: it sends on behalf of
 * every rep. Each row is its own transaction so one failure never holds up the queue.
 */
export async function drainOutbox(args: {
  db: DbAccess;
  deliver: Deliverer;
  now?: Date;
  appUrl: string;
  /** Stop after this many sends in one run (a scheduled function has a time budget). */
  max?: number;
}): Promise<DrainSummary> {
  const now = args.now ?? new Date();
  const summary: DrainSummary = { claimed: 0, sent: 0, skipped: 0, failed: 0, deferred: 0 };
  const settings = await args.db.withSystem(
    async (q) => (await q.query<Settings>("select * from shop_settings")).rows[0],
  );
  if (!settings) throw new Error("shop_settings row missing");
  const max = args.max ?? 200;

  for (let i = 0; i < max; i += 1) {
    const done = await args.db.withSystem(async (q) => {
      const { rows } = await q.query<Job>(
        `with next as (
           select o.id from outbox o
            where o.status = 'queued' and o.not_before <= $1
            order by case o.lane when 'intake' then 0 when 'reply' then 1 when 'system' then 2 when 'approval' then 2 when 'sequence' then 3 else 4 end,
                     o.not_before
            for update skip locked limit 1)
         update outbox o set status = 'sending', attempts = o.attempts + 1
           from next where o.id = next.id
         returning o.id, o.user_id, o.client_id, o.lane, o.source, o.to_address, o.subject, o.text_body, o.html_body, o.expires_at, o.attempts,
           o.last_error,
           (select email from app_users u where u.id = o.user_id) as rep_email,
           (select google_email from gmail_connections g where g.user_id = o.user_id) as gmail_address,
           (select status = 'ok' from gmail_connections g where g.user_id = o.user_id) as gmail_ok,
           (select email_opt_out from clients c where c.id = o.client_id) as client_opt_out,
           (select contact_status in ('dnc', 'no_email') from clients c where c.id = o.client_id) as client_dnc,
           exists (select 1 from trashed_clients tc where tc.client_id = o.client_id) as client_trashed,
           exists (select 1 from enrollments e where e.client_id = o.client_id and e.stopped_at is null and e.paused
                      and o.source like 'bucket:' || e.bucket_id::text || ':%') as enrollment_paused,
           (o.source like 'nudge:%' and app.nudge_overtaken(o.client_id, o.created_at)) as nudge_overtaken,
           (select state from clients c where c.id = o.client_id) as client_state,
           app.is_suppressed('email', o.to_address) as suppressed,
           (select unsubscribe_token from clients c where c.id = o.client_id) as unsubscribe_token,
           coalesce((select app.merchant_sent(o.client_id, interval '24 hours', $1::timestamptz)), 0) as merchant_24h,
           coalesce((select app.merchant_sent(o.client_id, interval '7 days', $1::timestamptz)), 0) as merchant_7d`,
        [now.toISOString()],
      );
      const job = rows[0];
      if (!job) return true;
      summary.claimed += 1;

      const skip = async (reason: string) => {
        await q.query("update outbox set status = 'skipped', skip_reason = $2 where id = $1", [
          job.id,
          reason,
        ]);
        summary.skipped += 1;
      };
      const cancel = async (reason: string) => {
        await q.query("update outbox set status = 'cancelled', skip_reason = $2 where id = $1", [
          job.id,
          reason,
        ]);
        summary.skipped += 1;
      };
      const defer = async (until: Date, reason: string) => {
        await q.query(
          "update outbox set status = 'queued', not_before = $2, last_error = $3 where id = $1",
          [job.id, until.toISOString(), reason],
        );
        summary.deferred += 1;
      };
      const hour = 3_600_000;

      if (job.expires_at && new Date(job.expires_at) < now) return (skip("expired"), false);
      // a deleted merchant gets no mail at all, whatever lane the row is on (S1-2)
      if (job.client_trashed) return (cancel("trashed"), false);
      if (job.suppressed) return (skip("suppressed"), false);
      if (job.client_opt_out) return (skip("opted_out"), false);
      if (job.client_dnc) return (skip("dnc"), false);
      // a nudge after an open goes only if nothing happened since it was queued (0552)
      if (job.nudge_overtaken) return (cancel("overtaken"), false);
      if (job.lane === "approval") {
        // Right before an approval email goes: is its approval still open with nothing stopping it (a reply, a pitch,
        // a pause, the hold date), is it still inside the merchant's day (a retry an hour later may not be), and is it
        // still for this rep and this address? Checked under a savepoint, so a bad row fails alone and the run goes on.
        let c: ApprovalCheck | undefined;
        try {
          await q.query("savepoint approval_check");
          c = (
            await q.query<ApprovalCheck>(
              `select app.approval_halt(app.approval_of($1)) as halt, cl.user_id as owner_id, cl.email,
                      app.client_timezone(cl) as tz, s.approval_window_start, s.approval_window_end,
                      s.approval_weekends, s.send_on_holidays
                 from clients cl cross join shop_settings s where cl.id = $2`,
              [job.source, job.client_id],
            )
          ).rows[0];
          // the zone is used below: a zone the database cannot read must fail here, inside the savepoint
          if (c) await q.query("select now() at time zone $1", [c.tz]);
          await q.query("release savepoint approval_check");
        } catch (e) {
          await q.query("rollback to savepoint approval_check");
          await q.query("update outbox set status = 'failed', last_error = $2 where id = $1", [
            job.id,
            `approval check: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500),
          ]);
          summary.failed += 1;
          return false;
        }
        if (!c) return (cancel("gone"), false);
        if (c.halt) return (cancel(c.halt), false);
        // the merchant changed hands: the email names the old rep, so it is filled again for the new one
        if (c.owner_id !== job.user_id) return (cancel("owner_changed"), false);
        if (c.email.trim().toLowerCase() !== job.to_address.trim().toLowerCase())
          return (cancel("address_changed"), false);
        const w: WindowInput = {
          timezone: c.tz,
          startHour: c.approval_window_start,
          endHour: c.approval_window_end,
          weekends: c.approval_weekends,
          holidays: c.send_on_holidays,
        };
        if (!inSendWindow(now, w)) {
          await defer(nextSendTime(now, w, 0), "outside_window");
          return false;
        }
      }
      const bulk = job.lane === "sequence" || job.lane === "blast";
      // mail the engine sends on its own: the sequence lanes and the approval emails
      const automated = bulk || job.lane === "approval";
      if (bulk && job.enrollment_paused) {
        // the rep pressed Pause (or the merchant said "not now"): the step waits, it is not lost
        await defer(new Date(now.getTime() + hour), "paused");
        return false;
      }
      if (automated && settings.postal_address.trim() === "") {
        // CAN-SPAM: automated mail carries a postal address or it does not go. Intake and replies still do.
        await defer(new Date(now.getTime() + hour), "no_postal_address");
        return false;
      }
      if (
        bulk &&
        !merchantCapAllows({
          sent24h: job.merchant_24h,
          sent7d: job.merchant_7d,
          perDay: settings.per_merchant_daily,
          perWeek: settings.per_merchant_weekly,
        })
      ) {
        // try again tomorrow in the window; the per-merchant rule is about frequency, not a lost message
        await defer(new Date(now.getTime() + 24 * hour), "per_merchant_cap");
        return false;
      }
      if (automated) {
        // the claim checker (S1-15): what the engine says on its own must be true for this merchant. An approval
        // email may say "approved" (the merchant is); every other rule holds.
        const text = `${job.subject}\n${job.text_body}`;
        const ctx = { state: job.client_state ?? "" };
        const claims = bulk
          ? checkClaims(text, ctx)
          : { ok: approvalClaims(text, ctx).length === 0, reasons: approvalClaims(text, ctx) };
        if (!claims.ok) {
          if (job.last_error !== "claim_check" && job.client_id)
            await q.query(
              "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
              [
                job.user_id,
                job.client_id,
                `Automated email held by the claim check: ${claims.reasons.join("; ")}`,
              ],
            );
          await defer(new Date(now.getTime() + hour), "claim_check");
          return false;
        }
      }

      // Which mailbox: automation goes out from the shop's Resend domain when set; everything else from the rep's Gmail.
      // An approval email is the rep's own one-to-one email: from their Gmail whenever it is connected (replies land
      // in the inbox the sync reads), the shop's domain only when it is not.
      const repMailbox = job.lane === "approval" && Boolean(job.gmail_address && job.gmail_ok);
      const useResend = automated && settings.automation_from !== "" && !repMailbox;
      if (useResend && !settings.dns_ok) {
        // the automation domain has not passed its SPF / DKIM / DMARC check (Settings → Email): hold, do not fall back
        await defer(new Date(now.getTime() + hour), "dns_not_verified");
        return false;
      }
      let mailboxId: string;
      let providerLimit = 2000;
      if (useResend) {
        mailboxId = await mailboxFor(q, "resend", null, settings.automation_from, 50_000);
        providerLimit = 50_000;
      } else {
        if (!job.gmail_address || !job.gmail_ok) {
          await defer(new Date(now.getTime() + 6 * hour), "gmail_not_connected");
          return false;
        }
        providerLimit = job.gmail_address.toLowerCase().endsWith("@gmail.com") ? 500 : 2000;
        mailboxId = await mailboxFor(q, "gmail", job.user_id, job.gmail_address, providerLimit);
      }
      const sent24h =
        (
          await q.query<{ n: number }>("select app.mailbox_sent_24h($1, $2::timestamptz) as n", [
            mailboxId,
            now.toISOString(),
          ])
        ).rows[0]?.n ?? 0;
      const cap = capAllows(job.lane, {
        shopCap: settings.daily_cap,
        providerLimit,
        reserved: settings.reserved_for_intake,
        sent24h,
      });
      if (!cap.ok) {
        // the window rolls: the oldest send ages out 24h after it went
        const oldest = (
          await q.query<{ t: string | null }>(
            "select min(sent_at)::text as t from send_ledger where mailbox_id = $1 and sent_at > $2::timestamptz - interval '24 hours'",
            [mailboxId, now.toISOString()],
          )
        ).rows[0]?.t;
        const until = oldest
          ? new Date(new Date(oldest).getTime() + 24 * hour + 60_000)
          : new Date(now.getTime() + hour);
        await defer(until, "cap");
        return false;
      }

      // The footer is the engine's, not the template's: every automated email carries it. A designed approval email
      // has its own footer with the merchant's unsubscribe link in it (checked when it was saved): the HTML is sent
      // as designed and the footer goes on the plain-text part.
      let text = job.text_body;
      const designed =
        job.lane === "approval" && job.html_body !== null && job.html_body.trim() !== "";
      let html = designed ? (job.html_body ?? "") : textToHtml(job.text_body);
      // RFC 8058 one-click unsubscribe: Gmail and Yahoo require it on bulk mail
      let headers: Record<string, string> | undefined;
      if (automated && job.unsubscribe_token) {
        headers = {
          "List-Unsubscribe": `<${args.appUrl}/api/unsubscribe/${job.unsubscribe_token}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        };
        const f = legalFooter({
          shopName: settings.shop_name,
          postalAddress: settings.postal_address,
          unsubscribeUrl: `${args.appUrl}/u/${job.unsubscribe_token}`,
        });
        text += f.text;
        // a design without the shop's postal address gets the engine's footer too (the law asks for it)
        if (!designed) html += f.html;
        else if (!hasPostalAddress(job.text_body, settings.postal_address))
          html = withFooter(html, f.html);
      }

      try {
        const providerId = useResend
          ? await args.deliver.resend({
              to: job.to_address,
              subject: job.subject,
              text,
              html,
              // an approval's reply must reach the rep (and the inbox sync that stops the emails)
              replyTo:
                (settings.automation_reply_to_rep || job.lane === "approval") && job.rep_email
                  ? job.rep_email
                  : undefined,
              headers,
            })
          : await args.deliver.gmail(job.user_id, {
              to: job.to_address,
              subject: job.subject,
              text,
              ...(designed ? { html } : {}),
              headers,
            });
        await q.query(
          "update outbox set status = 'sent', provider = $2, provider_id = $3, sent_at = $4, last_error = null where id = $1",
          [job.id, useResend ? "resend" : "gmail", providerId, now.toISOString()],
        );
        await q.query(
          "insert into send_ledger (mailbox_id, outbox_id, client_id, lane, sent_at) values ($1, $2, $3, $4, $5)",
          [mailboxId, job.id, job.client_id, job.lane, now.toISOString()],
        );
        if (job.client_id) {
          await q.query("update clients set last_automated_email_at = $2 where id = $1 and $3", [
            job.client_id,
            now.toISOString(),
            automated,
          ]);
          await q.query(
            `insert into activities (user_id, client_id, kind, body) values ($1, $2, 'email', $3)`,
            [job.user_id, job.client_id, `${job.subject}\n\n${job.text_body}`],
          );
        }
        summary.sent += 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (job.attempts >= MAX_ATTEMPTS) {
          await q.query("update outbox set status = 'failed', last_error = $2 where id = $1", [
            job.id,
            msg,
          ]);
          summary.failed += 1;
        } else {
          await defer(new Date(now.getTime() + 15 * 60_000 * job.attempts), msg);
        }
      }
      return false;
    });
    if (done) break;
  }
  return summary;
}
