import { db as defaultDb, type DbAccess } from "../db";
import { sendViaResend } from "../email/resend";
import { env } from "../env";
import type { Attachment } from "../email/raw";
import { labelOf } from "../docs/label";
import type { BlobStore } from "../docs/storage";
import { acceptedNotice } from "../offers/notice";
import { finalPayment, offerNumber, validThroughWords, type Frequency } from "../offers/terms";

/**
 * When a merchant accepts an offer, the merchant's rep is emailed the terms and the documents (attached). The outbox job
 * sends it, right after it has scanned the uploads, so nothing unchecked is ever attached; the CRM's alert is at once.
 * It goes from the rep's own Gmail to themselves when that is connected, else from the shop's sending domain; with
 * neither, the error says why. A sender claims the notice first, so two never both send it.
 */

/** Gmail takes 25 MB a message; base64 grows files by a third. */
const ATTACH_MAX_BYTES = 17 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
// How long an accepted offer waits for a document's safety check before the email goes without it: 1 hour, written
// out in the two queries below (fixed SQL: nothing is interpolated into a query).

export interface NoticeSenders {
  /** Send from this rep's own Gmail (throws when it is not connected). */
  gmail(
    userId: string,
    m: { to: string; subject: string; text: string; html: string; attachments: Attachment[] },
  ): Promise<unknown>;
  /** Send from the shop's domain, or null when there is none. */
  resend:
    | ((m: {
        to: string;
        subject: string;
        text: string;
        html: string;
        attachments: Attachment[];
      }) => Promise<unknown>)
    | null;
}

interface Row {
  id: string;
  client_id: string;
  user_id: string;
  created_at: string;
  business_name: string;
  contact_name: string;
  funded_cents: string;
  payback_cents: string;
  payment_cents: string;
  payments: number;
  frequency: Frequency;
  factor_rate: string;
  accepted_at: string;
  accepted_name: string;
  accepted_email: string;
  accepted_ip: string;
  docs: string[];
  rep_to: string;
  rep_tz: string;
}

/** Email the rep about one accepted offer. Returns what happened, and writes it on the offer. */
export async function notifyOfferAccepted(
  offerId: string,
  deps: { store: BlobStore; senders: NoticeSenders; appUrl: string; db?: DbAccess },
): Promise<{ sent: boolean; error?: string }> {
  const access = deps.db ?? defaultDb;
  const r = await access.withSystem(async (q) => {
    // a document still in its safety check holds the email for up to an hour; after that the email goes without it
    // (and says so), so a file whose check keeps failing cannot hold back the rep's acceptance notice
    const { rows } = await q.query<Row>(
      `with claim as (
         update merchant_offers o set accept_notice_claimed_at = now()
          where o.id = $1 and o.status = 'accepted' and o.accept_notified_at is null
            and (o.accept_notice_claimed_at is null or o.accept_notice_claimed_at < now() - interval '10 minutes')
            and not exists (select 1 from documents d
                             where d.client_id = o.client_id and d.deleted_at is null and d.kind = any(o.docs)
                               and d.scan_status = 'pending' and d.created_at > now() - interval '1 hour')
          returning o.*)
       select o.id, o.client_id, c.user_id, o.created_at::text as created_at, c.business_name, c.contact_name,
              o.funded_cents::text, o.payback_cents::text, o.payment_cents::text, o.payments, o.frequency,
              o.factor_rate::text, o.accepted_at::text as accepted_at, o.accepted_name, o.accepted_email,
              o.accepted_ip, o.docs, coalesce(nullif(btrim(u.notify_email), ''), u.email) as rep_to,
              u.timezone as rep_tz
         from claim o join clients c on c.id = o.client_id join app_users u on u.id = c.user_id`,
      [offerId],
    );
    return rows[0];
  });
  // already sent, being sent by someone else, or a document is still being checked
  if (!r) return { sent: false, error: "nothing to send" };

  // the newest readable document of each kind the offer asked for
  const files = await access.withSystem(async (q) => {
    const { rows } = await q.query<{
      kind: string;
      filename: string;
      content_type: string;
      size_bytes: string;
      storage_key: string;
    }>(
      `select distinct on (kind) kind, filename, content_type, size_bytes::text, storage_key
         from documents
        where client_id = $1 and deleted_at is null and kind = any($2::text[]) and scan_status = 'clean'
        order by kind, created_at desc`,
      [r.client_id, r.docs],
    );
    return rows;
  });
  // asked for, never cleared, and past the wait: left off the email, and the rep is told
  const unscanned = await access.withSystem(async (q) => {
    const { rows } = await q.query<{ kind: string }>(
      `select distinct kind from documents
        where client_id = $1 and deleted_at is null and kind = any($2::text[]) and scan_status = 'pending'
          and kind <> all($3::text[])`,
      [r.client_id, r.docs, files.map((f) => f.kind)],
    );
    return rows.map((x) => labelOf(x.kind as Parameters<typeof labelOf>[0], null));
  });
  const attachments: Attachment[] = [];
  const attached: string[] = [];
  const notAttached: string[] = [];
  const unreadable: string[] = [];
  let total = 0;
  for (const f of files) {
    const label = labelOf(f.kind as Parameters<typeof labelOf>[0], null);
    const size = Number(f.size_bytes);
    if (total + size > ATTACH_MAX_BYTES) {
      notAttached.push(label);
      continue;
    }
    const stored = await deps.store.get(f.storage_key).catch(() => null);
    if (!stored) {
      unreadable.push(label);
      continue;
    }
    total += size;
    const ext = f.filename.includes(".") ? f.filename.slice(f.filename.lastIndexOf(".")) : "";
    attachments.push({
      filename: `${r.business_name} - ${label.replace(/\s*\/\s*/g, " - ")}${ext}`
        .replace(/[\\/:*?"<>|]/g, " ")
        .replace(/\s+/g, " "),
      // a stored type with parameters ("application/pdf; charset=binary") must not stop the email
      contentType: /^[\w.+-]+\/[\w.+-]+$/.test(stored.contentType || f.content_type)
        ? stored.contentType || f.content_type
        : "application/octet-stream",
      bytes: stored.bytes,
    });
    attached.push(label);
  }

  const mail = acceptedNotice({
    number: offerNumber(r.id, r.created_at),
    businessName: r.business_name,
    contactName: r.contact_name,
    fundedCents: Number(r.funded_cents),
    paymentCents: Number(r.payment_cents),
    finalPaymentCents: finalPayment(Number(r.payback_cents), Number(r.payment_cents), r.payments),
    paybackCents: Number(r.payback_cents),
    payments: r.payments,
    frequency: r.frequency,
    factorRate: Number(r.factor_rate),
    acceptedAt: r.accepted_at,
    acceptedName: r.accepted_name,
    acceptedEmail: r.accepted_email,
    acceptedIp: r.accepted_ip,
    attached,
    notAttached,
    unreadable,
    unscanned,
    merchantUrl: `${deps.appUrl.replace(/\/+$/, "")}/clients/${r.client_id}`,
    acceptedWords: validThroughWords(r.accepted_at, r.rep_tz),
  });
  const message = { to: r.rep_to, ...mail, attachments };

  let error: string | null = null;
  try {
    await deps.senders.gmail(r.user_id, message);
  } catch (e) {
    const gmailWhy = e instanceof Error ? e.message : String(e);
    if (deps.senders.resend) {
      try {
        await deps.senders.resend(message);
      } catch (e2) {
        error = `Gmail: ${gmailWhy}; the shop's domain: ${e2 instanceof Error ? e2.message : String(e2)}`;
      }
    } else {
      error = `${gmailWhy}. Connect Gmail (Settings) or set up the shop's sending domain to get these by email.`;
    }
  }
  await access.withSystem((q) =>
    q.query(
      `update merchant_offers
          set accept_notified_at = case when $2::text is null then now() end,
              accept_notice_attempts = accept_notice_attempts + 1,
              accept_notice_error = coalesce(left($2, 300), ''),
              accept_notice_claimed_at = null
        where id = $1`,
      [r.id, error],
    ),
  );
  return error ? { sent: false, error } : { sent: true };
}

/** The outbox job's retry: accepted offers whose email has not gone yet, a few at a time. */
export async function retryOfferNotices(deps: {
  store: BlobStore;
  senders: NoticeSenders;
  appUrl: string;
  db?: DbAccess;
}): Promise<{ tried: number; sent: number }> {
  const access = deps.db ?? defaultDb;
  const ids = await access.withSystem(async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `select id from merchant_offers
        where status = 'accepted' and accept_notified_at is null and accept_notice_attempts < $1
          and accepted_at > now() - interval '7 days'
          and (accept_notice_claimed_at is null or accept_notice_claimed_at < now() - interval '10 minutes')
          and not exists (select 1 from documents d
                           where d.client_id = merchant_offers.client_id and d.deleted_at is null
                             and d.kind = any(merchant_offers.docs) and d.scan_status = 'pending'
                             and d.created_at > now() - interval '1 hour')
        order by accepted_at limit 3`,
      [MAX_ATTEMPTS],
    );
    return rows.map((x) => x.id);
  });
  let sent = 0;
  for (const id of ids) {
    const r = await notifyOfferAccepted(id, deps).catch(() => ({ sent: false }));
    if (r.sent) sent++;
  }
  return { tried: ids.length, sent };
}

/** The real senders: the rep's Gmail, and the shop's Resend domain when it is set up. */
export function productionNoticeSenders(): NoticeSenders {
  return {
    async gmail(userId, m) {
      const { sendEmailAsUser } = await import("./gmail");
      return sendEmailAsUser(userId, m);
    },
    resend: (() => {
      const e = env();
      if (!e.RESEND_API_KEY) return null;
      const apiKey = e.RESEND_API_KEY;
      return async (m: {
        to: string;
        subject: string;
        text: string;
        html: string;
        attachments: Attachment[];
      }) => {
        const from =
          (await defaultDb.withSystem(
            async (q) =>
              (
                await q.query<{ automation_from: string }>(
                  "select automation_from from shop_settings",
                )
              ).rows[0]?.automation_from,
          )) || e.RESEND_FROM;
        if (!from) throw new Error("no sending address for the shop's domain");
        return sendViaResend({ apiKey, from }, m);
      };
    })(),
  };
}
