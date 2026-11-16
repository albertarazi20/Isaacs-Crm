import type { Db, DbAccess } from "../db";
import { capAllows, legalFooter, merchantCapAllows, textToHtml, type Lane } from "./rules";

export interface Deliverer {
  /** Send through the rep's Gmail. Returns the provider id. */
  gmail(
    userId: string,
    m: { to: string; subject: string; text: string; headers?: Readonly<Record<string, string>> },
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
  expires_at: string | null;
  attempts: number;
  rep_email: string | null;
  gmail_address: string | null;
  gmail_ok: boolean;
  client_opt_out: boolean | null;
  client_dnc: boolean | null;
  suppressed: boolean;
  unsubscribe_token: string | null;
  merchant_24h: number;
  merchant_7d: number;
}

const MAX_ATTEMPTS = 3;

async function mailboxFor(
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
            order by case o.lane when 'intake' then 0 when 'reply' then 1 when 'system' then 2 when 'sequence' then 3 else 4 end,
                     o.not_before
            for update skip locked limit 1)
         update outbox o set status = 'sending', attempts = o.attempts + 1
           from next where o.id = next.id
         returning o.id, o.user_id, o.client_id, o.lane, o.source, o.to_address, o.subject, o.text_body, o.expires_at, o.attempts,
           (select email from app_users u where u.id = o.user_id) as rep_email,
           (select google_email from gmail_connections g where g.user_id = o.user_id) as gmail_address,
           (select status = 'ok' from gmail_connections g where g.user_id = o.user_id) as gmail_ok,
           (select email_opt_out from clients c where c.id = o.client_id) as client_opt_out,
           (select contact_status in ('dnc', 'no_email') from clients c where c.id = o.client_id) as client_dnc,
           app.is_suppressed('email', o.to_address) as suppressed,
           (select unsubscribe_token from clients c where c.id = o.client_id) as unsubscribe_token,
           coalesce((select app.merchant_sent(o.client_id, interval '24 hours')), 0) as merchant_24h,
           coalesce((select app.merchant_sent(o.client_id, interval '7 days')), 0) as merchant_7d`,
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
      const defer = async (until: Date, reason: string) => {
        await q.query(
          "update outbox set status = 'queued', not_before = $2, last_error = $3 where id = $1",
          [job.id, until.toISOString(), reason],
        );
        summary.deferred += 1;
      };

      if (job.expires_at && new Date(job.expires_at) < now) return (skip("expired"), false);
      if (job.suppressed) return (skip("suppressed"), false);
      if (job.client_opt_out) return (skip("opted_out"), false);
      if (job.client_dnc) return (skip("dnc"), false);
      const bulk = job.lane === "sequence" || job.lane === "blast";
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
        await defer(new Date(now.getTime() + 24 * 3_600_000), "per_merchant_cap");
        return false;
      }

      // Which mailbox: automation goes out from the shop's Resend domain when set; everything else from the rep's Gmail.
      const useResend = bulk && settings.automation_from !== "";
      let mailboxId: string;
      let providerLimit = 2000;
      if (useResend) {
        mailboxId = await mailboxFor(q, "resend", null, settings.automation_from, 50_000);
        providerLimit = 50_000;
      } else {
        if (!job.gmail_address || !job.gmail_ok) {
          await defer(new Date(now.getTime() + 6 * 3_600_000), "gmail_not_connected");
          return false;
        }
        providerLimit = job.gmail_address.toLowerCase().endsWith("@gmail.com") ? 500 : 2000;
        mailboxId = await mailboxFor(q, "gmail", job.user_id, job.gmail_address, providerLimit);
      }
      const sent24h =
        (await q.query<{ n: number }>("select app.mailbox_sent_24h($1) as n", [mailboxId])).rows[0]
          ?.n ?? 0;
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
            "select min(sent_at)::text as t from send_ledger where mailbox_id = $1 and sent_at > now() - interval '24 hours'",
            [mailboxId],
          )
        ).rows[0]?.t;
        const until = oldest
          ? new Date(new Date(oldest).getTime() + 24 * 3_600_000 + 60_000)
          : new Date(now.getTime() + 3_600_000);
        await defer(until, "cap");
        return false;
      }

      // The footer is the engine's, not the template's: every automated email carries it.
      let text = job.text_body;
      let html = textToHtml(job.text_body);
      // RFC 8058 one-click unsubscribe: Gmail and Yahoo require it on bulk mail
      let headers: Record<string, string> | undefined;
      if (bulk && job.unsubscribe_token) {
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
        html += f.html;
      }

      try {
        const providerId = useResend
          ? await args.deliver.resend({
              to: job.to_address,
              subject: job.subject,
              text,
              html,
              replyTo:
                settings.automation_reply_to_rep && job.rep_email ? job.rep_email : undefined,
              headers,
            })
          : await args.deliver.gmail(job.user_id, {
              to: job.to_address,
              subject: job.subject,
              text,
              headers,
            });
        await q.query(
          "update outbox set status = 'sent', provider = $2, provider_id = $3, sent_at = $4 where id = $1",
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
            bulk,
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
