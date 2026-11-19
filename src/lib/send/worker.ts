import type { Db, DbAccess } from "../db";
import { approvalClaims, hasPostalAddress, withFooter } from "../approvals/html";
import { checkClaims, merchantOwnWords, stripMerchantText } from "../messaging/claims";
import {
  capAllows,
  inSendWindow,
  isDailySource,
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
  send_window_start: number;
  send_window_end: number;
  send_on_weekends: boolean;
  send_on_holidays: boolean;
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
  /** A daily reminder whose merchant is still a live member of that bucket, and the bucket still sends one. */
  daily_member: boolean;
  /** A nudge after an open that something since made wrong to send (app.nudge_overtaken). */
  nudge_overtaken: boolean;
  client_state: string | null;
  /** The merchant's own words in the message (names): the claim check does not read them as the shop's claims. */
  client_business_name: string | null;
  client_contact_name: string | null;
  client_dba: string | null;
  /** The merchant's own time zone: the send window is theirs. */
  tz: string | null;
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

/** Why a deferred bucket step never went out, in words for the merchant's timeline (the outbox row's last deferral). */
const UNSENT_WHY: Record<string, string> = {
  gmail_not_connected: "the rep's Gmail is not connected",
  claim_check: "held by the claim check",
  dns_not_verified: "the sending domain is not verified yet",
  no_postal_address: "the shop's postal address is not set",
  paused: "the follow-up was paused",
  per_merchant_cap: "the per-merchant sending limit",
  cap: "the daily sending cap",
  outside_window: "outside the sending window",
};

/** Socket-level codes where the request may already have reached the provider before the connection died. */
const AMBIGUOUS_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * Did the provider call end without an answer? A timeout or a dropped connection after the request went out says
 * nothing about whether the email left: sending it again can deliver it twice, so such a row is failed for a person
 * to check, never retried by itself. A real answer (an error status the provider returned) or a failure before the
 * request existed (a refused or unresolvable connection, a missing grant) is a plain failure and is retried.
 */
export function isAmbiguousSendError(e: unknown): boolean {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === "object" && depth < 4; depth += 1) {
    const err = cur as { name?: unknown; code?: unknown; cause?: unknown };
    if (err.name === "TimeoutError" || err.name === "AbortError") return true;
    if (typeof err.code === "string" && AMBIGUOUS_CODES.has(err.code)) return true;
    cur = err.cause;
  }
  return false;
}

/** What the claim step hands to the send step: everything the provider call and the bookkeeping afterwards need. */
interface Ready {
  job: Job;
  mailboxId: string;
  useResend: boolean;
  /** When a failed send is tried again: window-aware for the bulk lanes. */
  retryAt: (attempts: number) => Date;
  mail: {
    text: string;
    html: string;
    designed: boolean;
    headers: Record<string, string> | undefined;
    replyTo: string | undefined;
  };
  automated: boolean;
}

/** A row left in 'sending' this long never got its result written: the provider may or may not have sent it. */
const STALE_SENDING_MINUTES = 30;

/** The sending identity a ledger row keys on: a user's Gmail or the shop's Resend domain. Upserted, never duplicated. */
export async function mailboxFor(
  q: Db,
  kind: "gmail" | "resend",
  userId: string | null,
  address: string,
  limit: number,
): Promise<string> {
  if (kind === "gmail") {
    // One Gmail mailbox per rep (mailboxes_user_gmail_key). A Google account already on the ledger is that mailbox
    // (two reps on one account share its real daily limit), so it is reused as it is. Otherwise a rep who reconnected
    // as another account keeps their row, moved to the new address; the limit follows only when the address moves.
    const held = await q.query<{ id: string }>(
      "update mailboxes set active = true where kind = 'gmail' and address = $1 returning id",
      [address],
    );
    if (held.rows[0]) return held.rows[0].id;
    const moved = await q.query<{ id: string }>(
      `update mailboxes set address = $2, provider_limit = $3, active = true
        where kind = 'gmail' and user_id = $1 returning id`,
      [userId, address, limit],
    );
    if (moved.rows[0]) return moved.rows[0].id;
  }
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
  /** Stop claiming new rows after this many milliseconds of wall clock (the scheduled function is killed at 60 s). */
  budgetMs?: number;
}): Promise<DrainSummary> {
  const now = args.now ?? new Date();
  const summary: DrainSummary = { claimed: 0, sent: 0, skipped: 0, failed: 0, deferred: 0 };
  const loaded = await args.db.withSystem(
    async (q) => (await q.query<Settings>("select * from shop_settings")).rows[0],
  );
  if (!loaded) throw new Error("shop_settings row missing");
  const settings: Settings = loaded;
  const max = args.max ?? 200;
  const started = Date.now();
  const budgetMs = args.budgetMs ?? 40_000;

  // A row stuck in 'sending' is one whose run died. If it carries the 'pending' marker the provider call had started and
  // its result was never written: it may have gone out, so it is never sent again on a guess but marked failed, for a
  // person to check against the rep's Sent folder. Without the marker it never reached the provider: it is queued again.
  const stale = await args.db.withSystem(async (q) => {
    const interrupted = await q.query(
      `update outbox set status = 'failed',
              last_error = 'interrupted while sending: it may have gone out, check the Sent folder before sending again'
        where status = 'sending' and provider_id = 'pending' and not_before < $1::timestamptz - make_interval(mins => $2)`,
      [now.toISOString(), STALE_SENDING_MINUTES],
    );
    await q.query(
      `update outbox set status = 'queued', attempts = greatest(attempts - 1, 0),
              last_error = 'interrupted before sending: queued again'
        where status = 'sending' and provider_id is distinct from 'pending'
          and not_before < $1::timestamptz - make_interval(mins => $2)`,
      [now.toISOString(), STALE_SENDING_MINUTES],
    );
    return interrupted;
  });
  summary.failed += stale.rowCount ?? 0;

  const bulkWindow = (tz: string | null): WindowInput => ({
    timezone: tz || "America/New_York",
    startHour: settings.send_window_start,
    endHour: settings.send_window_end,
    weekends: settings.send_on_weekends,
    holidays: settings.send_on_holidays,
  });
  // a bucket's daily reminder goes at the shop's reminder time, not in the shared send window: its retries are not re-timed
  const windowed = (lane: string, tz: string | null, at: Date, source = ""): Date =>
    (lane === "sequence" || lane === "blast") && !isDailySource(source)
      ? nextSendTime(at, bulkWindow(tz))
      : at;
  let claimed: { id: string; lane: string; tz: string | null; source: string } | null = null;
  for (let i = 0; i < max && Date.now() - started < budgetMs; i += 1) {
    claimed = null;
    let done: boolean | Ready;
    try {
      done = await claimNext();
    } catch (e) {
      // The claim rolled back, so the row is still queued. A refusal that will come again (a zone or mailbox the
      // database rejects: data and integrity errors) fails it alone; anything else (a dropped connection, a timeout)
      // counts an attempt and tries again later, so one blip never loses the mail and a bad row never holds up the rest.
      if (!claimed) throw e;
      const row: { id: string; lane: string; tz: string | null; source: string } = claimed;
      const code = (e as { code?: unknown }).code;
      const permanent = typeof code === "string" && /^(22|23)/.test(code);
      const msg = `could not prepare: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      await args.db.withSystem(async (q) => {
        const prior = (
          await q.query<{ attempts: number }>(
            "select attempts from outbox where id = $1 and status = 'queued'",
            [row.id],
          )
        ).rows[0];
        if (!prior) return;
        const attempts = prior.attempts + 1;
        if (permanent || attempts >= MAX_ATTEMPTS) {
          await q.query(
            "update outbox set status = 'failed', attempts = $2, last_error = $3 where id = $1",
            [row.id, attempts, msg],
          );
          summary.failed += 1;
        } else {
          const at = windowed(
            row.lane,
            row.tz,
            new Date(now.getTime() + 15 * 60_000 * attempts),
            row.source,
          );
          await q.query(
            "update outbox set attempts = $2, not_before = $3, last_error = $4 where id = $1",
            [row.id, attempts, at.toISOString(), msg],
          );
          summary.deferred += 1;
        }
      });
      continue;
    }
    if (done === true) break;
    if (done === false) continue;
    await sendAndRecord(done);
  }
  return summary;

  /** Claim one due row and run every check; returns true (nothing due), false (handled: skipped, deferred...) or what to send. */
  async function claimNext(): Promise<boolean | Ready> {
    return args.db.withSystem(async (q): Promise<boolean | Ready> => {
      const { rows } = await q.query<Job>(
        `with next as (
           select o.id from outbox o
            where o.status = 'queued' and o.not_before <= $1
              -- a disabled rep sends nothing: the row waits (it goes only if the person is switched on again)
              and exists (select 1 from app_users u where u.id = o.user_id and u.active)
            order by case o.lane when 'intake' then 0 when 'reply' then 1 when 'system' then 2 when 'approval' then 2 when 'sequence' then 3 else 4 end,
                     o.not_before
            for update skip locked limit 1)
         update outbox o set status = 'sending'
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
           exists (select 1 from enrollments e join buckets b on b.id = e.bucket_id
                    where e.client_id = o.client_id and e.stopped_at is null and b.daily_template_id is not null
                      and o.source like 'bucket:' || e.bucket_id::text || ':daily:%') as daily_member,
           (o.source like 'nudge:%' and app.nudge_overtaken(o.client_id, o.created_at)) as nudge_overtaken,
           (select state from clients c where c.id = o.client_id) as client_state,
           (select business_name from clients c where c.id = o.client_id) as client_business_name,
           (select contact_name from clients c where c.id = o.client_id) as client_contact_name,
           (select dba from clients c where c.id = o.client_id) as client_dba,
           (select app.client_timezone(c) from clients c where c.id = o.client_id) as tz,
           app.is_suppressed('email', o.to_address) as suppressed,
           (select unsubscribe_token from clients c where c.id = o.client_id) as unsubscribe_token,
           coalesce((select app.merchant_sent(o.client_id, interval '24 hours', $1::timestamptz)), 0) as merchant_24h,
           coalesce((select app.merchant_sent(o.client_id, interval '7 days', $1::timestamptz)), 0) as merchant_7d`,
        [now.toISOString()],
      );
      const job = rows[0];
      if (!job) return true;
      claimed = { id: job.id, lane: job.lane, tz: job.tz, source: job.source };
      summary.claimed += 1;

      // A bucket step that ends unsent (it sat past its 36 hours because the rep's Gmail was not connected, the claim
      // check held it, the sending domain was not verified...) is written on the merchant's timeline, and the step no
      // longer counts as sent: the sequence has already moved on, so without this the merchant could be walked through
      // every step and into Cold with nothing ever sent, and nobody would know. A merchant who stopped the mail
      // themselves (opt-out, do-not-contact, trash, suppression) has their own timeline entry already.
      const unsentStep = async (reason: string) => {
        const m = /^bucket:([0-9a-f-]{36}):step:(\d+)$/.exec(job.source);
        // a daily reminder that ends unsent also stops counting as sent (the "N sent" line), but gets no timeline entry:
        // it would be one a day for as long as the mail cannot go
        const dailyBucketId = isDailySource(job.source) ? job.source.split(":")[1] : undefined;
        const bucketId = m?.[1] ?? dailyBucketId;
        if (job.lane !== "sequence" || !bucketId || !job.client_id) return;
        if (["suppressed", "opted_out", "dnc", "trashed"].includes(reason)) return;
        const why = job.last_error ? UNSENT_WHY[job.last_error] : undefined;
        await q.query(
          "update enrollments set steps_sent = greatest(steps_sent - 1, 0) where client_id = $1 and bucket_id = $2 and stopped_at is null",
          [job.client_id, bucketId],
        );
        if (!m) return;
        await q.query(
          "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
          [
            job.user_id,
            job.client_id,
            `Bucket email step ${m[2]} ${reason === "expired" ? "expired" : "was cancelled"} unsent: ${why ?? job.last_error ?? reason}`,
          ],
        );
      };
      const skip = async (reason: string) => {
        await q.query("update outbox set status = 'skipped', skip_reason = $2 where id = $1", [
          job.id,
          reason,
        ]);
        await unsentStep(reason);
        summary.skipped += 1;
      };
      const cancel = async (reason: string) => {
        await q.query("update outbox set status = 'cancelled', skip_reason = $2 where id = $1", [
          job.id,
          reason,
        ]);
        await unsentStep(reason);
        summary.skipped += 1;
      };
      // Sequence and blast mail goes only inside the merchant's send window, however it came to be re-timed (a cap
      // that rolls off at 03:12, a Pause, a retry): every deferral of such a row lands on the next slot in the window.
      const inWindow = (at: Date): Date => windowed(job.lane, job.tz, at, job.source);
      const defer = async (until: Date, reason: string) => {
        await q.query(
          "update outbox set status = 'queued', not_before = $2, last_error = $3 where id = $1",
          [job.id, inWindow(until).toISOString(), reason],
        );
        summary.deferred += 1;
      };
      const hour = 3_600_000;

      if (job.expires_at && new Date(job.expires_at) < now) {
        await skip("expired");
        return false;
      }
      // a deleted merchant gets no mail at all, whatever lane the row is on (S1-2)
      if (job.client_trashed) {
        await cancel("trashed");
        return false;
      }
      if (job.suppressed) {
        await skip("suppressed");
        return false;
      }
      if (job.client_opt_out) {
        await skip("opted_out");
        return false;
      }
      if (job.client_dnc) {
        await skip("dnc");
        return false;
      }
      const daily = isDailySource(job.source);
      // a daily reminder goes only while the merchant is still in that bucket and the bucket still sends one
      if (daily && !job.daily_member) {
        await cancel("left_bucket");
        return false;
      }
      // a nudge after an open goes only if nothing happened since it was queued (0552)
      if (job.nudge_overtaken) {
        await cancel("overtaken");
        return false;
      }
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
        if (!c) {
          await cancel("gone");
          return false;
        }
        if (c.halt) {
          await cancel(c.halt);
          return false;
        }
        // the merchant changed hands: the email names the old rep, so it is filled again for the new one
        if (c.owner_id !== job.user_id) {
          await cancel("owner_changed");
          return false;
        }
        if (c.email.trim().toLowerCase() !== job.to_address.trim().toLowerCase()) {
          await cancel("address_changed");
          return false;
        }
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
      // Bulk mail is sent only inside the merchant's window at the moment it goes, not just when it was queued: a row
      // that waited (a rep switched off and on again, a stale 'sending' row queued again, a late cron run) is held
      // to the next slot instead of going at whatever hour the worker found it.
      if (bulk && !daily && !inSendWindow(now, bulkWindow(job.tz))) {
        await defer(now, "outside_window");
        return false;
      }
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
        !daily &&
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
        // the merchant's own business or contact name ("Guaranteed Roofing", "Mike's Loan Office") is not the shop's claim
        const text = stripMerchantText(
          `${job.subject}\n${job.text_body}`,
          merchantOwnWords({
            businessName: job.client_business_name,
            contactName: job.client_contact_name,
            dba: job.client_dba,
          }),
        );
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
      // a designed email (an approval email, an offer on the reply lane) goes as it was made; anything else is the text,
      // wrapped (the bulk lanes' claim and address checks read the text, so they never send a design)
      const designed =
        (job.lane === "approval" || job.lane === "reply") &&
        job.html_body !== null &&
        job.html_body.trim() !== "";
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

      // The provider call is made after this transaction commits (see sendAndRecord): the row stays 'sending', so no
      // other run claims it, and a database failure afterwards can never send the email a second time. Only a send
      // that is really about to be tried counts as an attempt (a deferral is not a failure).
      const marked = await q.query<{ attempts: number }>(
        "update outbox set attempts = attempts + 1, not_before = $2, provider_id = null where id = $1 returning attempts",
        [job.id, now.toISOString()],
      );
      job.attempts = marked.rows[0]?.attempts ?? job.attempts + 1;
      return {
        job,
        mailboxId,
        useResend,
        retryAt: (attempts) => inWindow(new Date(now.getTime() + 15 * 60_000 * attempts)),
        mail: {
          text,
          html,
          designed,
          headers,
          // an approval's reply must reach the rep (and the inbox sync that stops the emails)
          replyTo:
            (settings.automation_reply_to_rep || job.lane === "approval") && job.rep_email
              ? job.rep_email
              : undefined,
        },
        automated,
      };
    });
  }

  /** Make the provider call, then write what happened in a transaction of its own. */
  async function sendAndRecord(r: Ready): Promise<void> {
    const { job, mail } = r;
    // Mark that the provider call is about to start. A row that dies in 'sending' without the mark never reached the
    // provider and is queued again by the sweep; with it, it may have gone out and is failed for a person to check.
    try {
      await args.db.withSystem((q) =>
        q.query("update outbox set provider_id = 'pending' where id = $1 and status = 'sending'", [
          job.id,
        ]),
      );
    } catch (e) {
      // nothing was sent: leave the row for the sweep to queue again rather than send what cannot be tracked
      console.error(`outbox ${job.id}: could not mark the send, left for the sweep:`, e);
      return;
    }
    let providerId: string;
    try {
      providerId = r.useResend
        ? await args.deliver.resend({
            to: job.to_address,
            subject: job.subject,
            text: mail.text,
            html: mail.html,
            replyTo: mail.replyTo,
            headers: mail.headers,
          })
        : await args.deliver.gmail(job.user_id, {
            to: job.to_address,
            subject: job.subject,
            text: mail.text,
            ...(mail.designed ? { html: mail.html } : {}),
            headers: mail.headers,
          });
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      // no answer from the provider (a timeout, a dropped connection): it may have gone out, so it is not retried
      const ambiguous = isAmbiguousSendError(e);
      try {
        await args.db.withSystem(async (q) => {
          if (ambiguous) {
            await q.query(
              "update outbox set status = 'failed', provider_id = null, last_error = $2 where id = $1",
              [
                job.id,
                `no answer from the provider, it may have gone out: check the Sent folder before sending again (${msg})`.slice(
                  0,
                  500,
                ),
              ],
            );
            summary.failed += 1;
          } else if (job.attempts >= MAX_ATTEMPTS) {
            await q.query(
              "update outbox set status = 'failed', provider_id = null, last_error = $2 where id = $1",
              [job.id, msg],
            );
            summary.failed += 1;
          } else {
            await q.query(
              "update outbox set status = 'queued', provider_id = null, not_before = $2, last_error = $3 where id = $1",
              [job.id, r.retryAt(job.attempts).toISOString(), msg],
            );
            summary.deferred += 1;
          }
        });
      } catch (e2) {
        // the database is down while recording the failure: the row stays 'sending' and the sweep deals with it. Say
        // which one, and let the run go on with the other rows.
        console.error(
          `outbox ${job.id}: the provider failed (${msg}), and recording it failed:`,
          e2,
        );
      }
      return;
    }
    // The provider has the email. Whatever happens to the bookkeeping from here, it is never sent again.
    summary.sent += 1;
    const sentAt = now.toISOString();
    try {
      await args.db.withSystem(async (q) => {
        await q.query(
          "update outbox set status = 'sent', provider = $2, provider_id = $3, sent_at = $4, last_error = null where id = $1",
          [job.id, r.useResend ? "resend" : "gmail", providerId, sentAt],
        );
        await q.query(
          "insert into send_ledger (mailbox_id, outbox_id, client_id, lane, sent_at) values ($1, $2, $3, $4, $5)",
          [r.mailboxId, job.id, job.client_id, job.lane, sentAt],
        );
        if (job.client_id) {
          await q.query("update clients set last_automated_email_at = $2 where id = $1 and $3", [
            job.client_id,
            sentAt,
            r.automated,
          ]);
          await q.query(
            `insert into activities (user_id, client_id, kind, body) values ($1, $2, 'email', $3)`,
            [job.user_id, job.client_id, `${job.subject}\n\n${job.text_body}`],
          );
        }
      });
    } catch (e) {
      // the full bookkeeping failed as one: at least record that it went, so it is neither retried nor swept as unknown
      console.error(`outbox ${job.id}: sent (provider id ${providerId}), bookkeeping failed:`, e);
      try {
        await args.db.withSystem((q) =>
          q.query(
            "update outbox set status = 'sent', provider = $2, provider_id = $3, sent_at = $4, last_error = $5 where id = $1",
            [
              job.id,
              r.useResend ? "resend" : "gmail",
              providerId,
              sentAt,
              `sent; bookkeeping failed: ${e instanceof Error ? e.message : String(e)}`.slice(
                0,
                500,
              ),
            ],
          ),
        );
      } catch (e2) {
        // the database is still down: the email has gone out and is never sent again (the row stays 'sending' and the
        // sweep marks it for a person to check). Say which one, and let the run go on with the other rows.
        console.error(
          `outbox ${job.id}: sent (provider id ${providerId}), even the fallback write failed:`,
          e2,
        );
      }
    }
  }
}
