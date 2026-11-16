/**
 * System-side handling of what merchants and mail providers send back: replies (Gmail sync or Resend inbound),
 * bounces and complaints (Resend webhooks), unsubscribes (the footer link). Everything lands in SQL functions so the
 * rules live in one place; this file is the glue and the alerts.
 */
import type { Db, DbAccess } from "../db";
import { htmlToText, parseAddress, splitMessageIds } from "../inbox/gmailRead";
import { authResults, dealTokenIn, domainOf, matchEmail } from "../inbox/match";
import { loadCandidates } from "../inbox/sync";
import { isStopMessage } from "../messaging/stop";
import type { DigestSender } from "./reminders";

/** "Name <a@b.com>" or "a@b.com" → lower-cased address, or "" when there is none. */
export function addressOf(s: string): string {
  const m = s.match(/<([^<>\s]+@[^<>\s]+)>/) ?? s.match(/([^\s<>",;]+@[^\s<>",;]+)/);
  return (m?.[1] ?? "").toLowerCase();
}

/** Header values of an inbound Resend payload, whichever shape the provider used ({name,value}[] or a map). */
function headerOf(d: Record<string, unknown>, name: string): string {
  const h = d["headers"];
  const want = name.toLowerCase();
  if (Array.isArray(h)) {
    for (const x of h) {
      const r = x as Record<string, unknown>;
      if (String(r["name"] ?? "").toLowerCase() === want) return String(r["value"] ?? "");
    }
    return "";
  }
  if (h && typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>))
      if (k.toLowerCase() === want) return String(v ?? "");
  }
  return "";
}

/**
 * A From header is forgeable. An inbound message counts as the merchant's only when SPF and DKIM both pass, or when
 * it replies to an email the CRM sent that merchant (In-Reply-To / References name one of our provider ids).
 */
async function inboundVerified(
  q: Db,
  d: Record<string, unknown>,
  clientId: string,
): Promise<boolean> {
  const auth = authResults(headerOf(d, "authentication-results") || null);
  if (auth.spf === true && auth.dkim === true) return true;
  const refs = `${headerOf(d, "in-reply-to")} ${headerOf(d, "references")}`;
  if (refs.trim() === "") return false;
  const { rows } = await q.query<{ provider_id: string }>(
    "select provider_id from outbox where client_id = $1 and status = 'sent' and provider_id is not null",
    [clientId],
  );
  return rows.some((r) => r.provider_id !== "" && refs.includes(r.provider_id));
}

const mask = (email: string): string => {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(6, user.length - 1)))}@${domain}`;
};

// ---------- replies ----------

export async function recordMerchantReply(
  db: DbAccess,
  a: { clientId: string; subject: string; snippet: string; from: string; text?: string },
): Promise<{ stop: boolean }> {
  const stop = isStopMessage(a.subject, a.text ?? a.snippet);
  await db.withSystem((q) =>
    q.query("select record_merchant_reply($1, $2, $3, $4, $5)", [
      a.clientId,
      a.subject,
      a.snippet,
      a.from,
      stop,
    ]),
  );
  return { stop };
}

/** The merchant behind an address, if we have exactly that email on a live merchant. */
export async function clientByEmail(db: DbAccess, address: string): Promise<string | null> {
  const email = addressOf(address);
  if (!email) return null;
  return db.withSystem(async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `select c.id from clients c where lower(c.email) = $1 and c.email <> ''
         and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
        order by c.created_at desc limit 1`,
      [email],
    );
    return rows[0]?.id ?? null;
  });
}

// ---------- Resend webhooks ----------

export interface ResendEvent {
  type: string;
  created_at?: string;
  data: Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The body of an inbound message, fetched from the provider when the webhook payload carried none. */
export type InboundFetcher = (emailId: string) => Promise<{ text?: string; html?: string } | null>;

/**
 * Resend's receiving API: the stored inbound message by id. Used only when the webhook payload has no text or
 * html. A miss (404, a network error) is null and the message is stored with the snippet it came with.
 */
export function resendInboundFetcher(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): InboundFetcher {
  return async (emailId) => {
    try {
      const res = await fetchImpl(
        `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
        { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as {
        text?: unknown;
        html?: unknown;
      } | null;
      return body ? { text: str(body.text), html: str(body.html) } : null;
    } catch {
      return null;
    }
  };
}

/** The names of the attachments on an inbound payload, whichever shape the provider used. */
function attachmentNames(d: Record<string, unknown>): string[] {
  const a = d["attachments"];
  if (!Array.isArray(a)) return [];
  return a
    .map((x) =>
      str((x as Record<string, unknown>)["filename"] ?? (x as Record<string, unknown>)["name"]),
    )
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * Route B (S2-5): mail from anyone who is not a merchant lands on the shop's deals inbox. A lender's answer is stored
 * like Gmail mail — matched to its deal by the same ladder (reply headers → [D-n] token → lender domain + business
 * name) — and processInbox reads it. A stranger (no match, no lender domain, no deal token) is kept only in
 * webhook_events. Returns the result word for the event row.
 */
async function storeLenderMail(
  q: Db,
  eventId: string,
  evt: ResendEvent,
  fetchInbound: InboundFetcher | undefined,
): Promise<string> {
  const d = evt.data ?? {};
  const emailId = str(d["email_id"]) || str(d["id"]);
  const from = parseAddress(str(d["from"]));
  const subject = str(d["subject"]);
  const html = str(d["html"]);
  let text = str(d["text"]);
  if (!text && !html && fetchInbound && emailId) {
    const got = await fetchInbound(emailId);
    if (got?.text) text = got.text;
    else if (got?.html) text = htmlToText(got.html);
  }
  if (!text && html) text = htmlToText(html);
  if (!text) text = str(d["snippet"]);
  const references = splitMessageIds(headerOf(d, "references") || str(d["references"]));
  const inReplyTo = headerOf(d, "in-reply-to") || str(d["in_reply_to"]) || null;
  const candidates = await loadCandidates(q);
  const match = matchEmail(
    { threadId: null, inReplyTo, references, fromAddress: from.address, subject, text },
    candidates,
  );
  const lenderDomain = candidates.some(
    (c) => c.funderDomain && c.funderDomain === domainOf(from.address),
  );
  if (!match && !lenderDomain && dealTokenIn(subject) === null) return "received:unknown_sender";
  const auth = authResults(headerOf(d, "authentication-results") || null);
  const to = d["to"];
  const toAddresses = (Array.isArray(to) ? to.map(str) : [str(to)])
    .map((x) => parseAddress(x).address)
    .filter(Boolean);
  const receivedAt =
    evt.created_at && !Number.isNaN(Date.parse(evt.created_at)) ? evt.created_at : null;
  const stored = await q.query(
    `insert into inbound_emails (mailbox_user_id, channel, gmail_id, message_id, in_reply_to, references_ids, from_address, from_name,
                                 to_addresses, subject, snippet, text_body, attachment_names, received_at, spf_pass, dkim_pass,
                                 deal_id, submission_id, client_id, funder_id, matched_by, kind)
     values (null, 'resend', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12::timestamptz, now()), $13, $14, $15, $16, $17, $18, $19, 'lender')
     on conflict do nothing`,
    [
      `resend:${emailId || eventId}`,
      headerOf(d, "message-id") || str(d["message_id"]) || null,
      inReplyTo,
      references,
      from.address,
      from.name,
      toAddresses,
      subject,
      text.slice(0, 240),
      text.slice(0, 200_000),
      attachmentNames(d),
      receivedAt,
      auth.spf,
      auth.dkim,
      match?.candidate.dealId ?? null,
      match?.candidate.submissionId ?? null,
      match?.candidate.clientId ?? null,
      match?.candidate.funderId ?? null,
      match ? match.by : "none",
    ],
  );
  if (stored.rowCount === 0) return "received:lender:duplicate";
  return match ? `received:lender:${match.by}` : "received:lender:unmatched";
}

/**
 * One Resend event. Stored first (idempotent on the provider's event id), then applied. Unknown types are kept and
 * marked ignored, so a new event type shows up in the table before anyone writes code for it.
 */
export async function handleResendEvent(
  db: DbAccess,
  eventId: string,
  evt: ResendEvent,
  opts: { fetchInbound?: InboundFetcher } = {},
): Promise<{ result: string }> {
  return db.withSystem(async (q) => {
    const stored = await q.query(
      "insert into webhook_events (provider, event_id, type, payload) values ('resend', $1, $2, $3::jsonb) on conflict do nothing",
      [eventId, evt.type, JSON.stringify(evt)],
    );
    if (stored.rowCount === 0) return { result: "duplicate" };
    let result = "ignored";
    const d = evt.data ?? {};
    const emailId = str(d["email_id"]);
    try {
      switch (evt.type) {
        case "email.delivered": {
          const c = await q.query<{ id: string | null }>(
            "select record_delivery_event('resend', $1, 'delivered') as id",
            [emailId],
          );
          result = c.rows[0]?.id ? "delivered" : "delivered:unknown_email";
          break;
        }
        case "email.bounced": {
          const bounce = (d["bounce"] ?? {}) as Record<string, unknown>;
          const type = str(bounce["type"]).toLowerCase();
          const hard = type === "" || type === "permanent" || type === "hard";
          const note = [str(bounce["subType"]), str(bounce["message"])].filter(Boolean).join(": ");
          const c = await q.query<{ id: string | null }>(
            "select record_delivery_event('resend', $1, $2, $3) as id",
            [emailId, hard ? "hard_bounce" : "soft_bounce", note],
          );
          result = c.rows[0]?.id ? (hard ? "hard_bounce" : "soft_bounce") : "bounce:unknown_email";
          break;
        }
        case "email.complained": {
          const c = await q.query<{ id: string | null }>(
            "select record_delivery_event('resend', $1, 'complaint', 'spam complaint') as id",
            [emailId],
          );
          result = c.rows[0]?.id ? "complaint" : "complaint:unknown_email";
          break;
        }
        case "email.received": {
          // inbound on the automation domain: a merchant answering a sequence email, or a lender answering a
          // submission on the shop's deals inbox (Route B)
          const from = str(d["from"]);
          const subject = str(d["subject"]);
          const text = str(d["text"]) || str(d["snippet"]);
          const { rows } = await q.query<{ id: string }>(
            `select c.id from clients c where lower(c.email) = $1 and c.email <> ''
               and not exists (select 1 from trashed_clients tc where tc.client_id = c.id) order by c.created_at desc limit 1`,
            [addressOf(from)],
          );
          const clientId = rows[0]?.id;
          if (!clientId) {
            result = await storeLenderMail(q, eventId, evt, opts.fetchInbound);
            break;
          }
          if (!(await inboundVerified(q, d as Record<string, unknown>, clientId))) {
            result = "received:unverified_sender";
            break;
          }
          const stop = isStopMessage(subject, text);
          await q.query("select record_merchant_reply($1, $2, $3, $4, $5)", [
            clientId,
            subject,
            text.slice(0, 240),
            addressOf(from),
            stop,
          ]);
          result = stop ? "received:stop" : "received:reply";
          break;
        }
        default:
          result = "ignored";
      }
    } catch (e) {
      result = `error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    }
    await q.query(
      "update webhook_events set handled_at = now(), result = $2 where provider = 'resend' and event_id = $1",
      [eventId, result],
    );
    return { result };
  });
}

// ---------- unsubscribe ----------

export interface UnsubscribeView {
  clientId: string;
  businessName: string;
  maskedEmail: string;
  shopName: string;
  already: boolean;
}

export async function resolveUnsubscribe(
  db: DbAccess,
  token: string,
): Promise<UnsubscribeView | null> {
  if (!/^[A-Za-z0-9]{20,80}$/.test(token)) return null;
  return db.withSystem(async (q) => {
    const { rows } = await q.query<{
      id: string;
      business_name: string;
      email: string;
      email_opt_out: boolean;
      shop_name: string;
    }>(
      `select c.id, c.business_name, c.email, c.email_opt_out, (select shop_name from shop_settings) as shop_name
         from clients c where c.unsubscribe_token = $1`,
      [token],
    );
    const c = rows[0];
    if (!c) return null;
    return {
      clientId: c.id,
      businessName: c.business_name,
      maskedEmail: c.email ? mask(c.email) : "",
      shopName: c.shop_name,
      already: c.email_opt_out,
    };
  });
}

/** The footer link or a mail client's one-click POST. True when a merchant was opted out (or already was). */
export async function unsubscribeByToken(
  db: DbAccess,
  token: string,
  source: "page" | "one_click",
): Promise<boolean> {
  const v = await resolveUnsubscribe(db, token);
  if (!v) return false;
  if (!v.already) {
    await db.withSystem(async (q) => {
      await q.query("select opt_out($1, 'email', 'unsubscribe', $2)", [
        v.clientId,
        source === "one_click" ? "one-click from the mail client" : "the unsubscribe page",
      ]);
      await q.query("select stop_enrollment($1, 'opted_out')", [v.clientId]);
    });
  }
  return true;
}

// ---------- the rep's alert ----------

export const REPLY_ALERTS_PER_DAY = 30;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * "Pizza Palace replied" to the rep, once per merchant per day, under the reminder switch. The now-list shows the
 * same thing; this is for the rep who is not looking at the app.
 */
export async function sendReplyAlerts(
  db: DbAccess,
  clientIds: readonly string[],
  a: { now: Date; appUrl: string; send: DigestSender },
): Promise<{ sent: number; skipped: number; failed: number }> {
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const clientId of new Set(clientIds)) {
    const r = await db.withSystem(async (q) => {
      const { rows } = await q.query<{
        user_id: string;
        to_email: string;
        digest_enabled: boolean;
        timezone: string;
        business_name: string;
        contact_name: string;
        subject: string;
        body: string;
      }>(
        `select u.id as user_id, coalesce(u.notify_email, u.email) as to_email, u.digest_enabled, u.timezone,
                c.business_name, c.contact_name, c.reply_waiting_subject as subject,
                coalesce((select a.body from activities a where a.client_id = c.id and a.kind = 'email' and a.body like 'Merchant replied%'
                           order by a.occurred_at desc limit 1), '') as body
           from clients c join app_users u on u.id = c.user_id where c.id = $1 and u.active`,
        [clientId],
      );
      const row = rows[0];
      if (!row || !row.digest_enabled) return "skipped" as const;
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: row.timezone || "UTC" }).format(
        a.now,
      );
      const used = await q.query<{ n: number }>(
        "select count(*)::int as n from reminders_sent where user_id = $1 and kind = 'reply' and for_date = $2",
        [row.user_id, day],
      );
      if ((used.rows[0]?.n ?? 0) >= REPLY_ALERTS_PER_DAY) return "skipped" as const;
      const claim = await q.query(
        "insert into reminders_sent (user_id, kind, for_date, ref) values ($1, 'reply', $2, $3) on conflict do nothing",
        [row.user_id, day, clientId],
      );
      if (claim.rowCount === 0) return "skipped" as const;
      const link = `${a.appUrl}/clients/${clientId}`;
      const who = row.contact_name
        ? `${row.contact_name} at ${row.business_name}`
        : row.business_name;
      const subject = `${row.business_name} replied${row.subject ? `: ${row.subject}` : ""}`;
      const text = `${who} wrote back.\n\n${row.body}\n\nOpen the merchant: ${link}\n\nTheir reminder sequence has stopped. Answer them today.`;
      const html = `<p><strong>${esc(who)}</strong> wrote back.</p><p style="color:#374151">${esc(row.body)}</p><p><a href="${esc(link)}">Open the merchant</a></p><p style="color:#6b7280;font-size:13px">Their reminder sequence has stopped. Answer them today.</p>`;
      try {
        const providerId = await a.send(row.to_email, { subject, text, html });
        await q.query(
          "update reminders_sent set provider_id = $4 where user_id = $1 and kind = 'reply' and for_date = $2 and ref = $3",
          [row.user_id, day, clientId, providerId],
        );
        return "sent" as const;
      } catch {
        await q.query(
          "delete from reminders_sent where user_id = $1 and kind = 'reply' and for_date = $2 and ref = $3 and provider_id is null",
          [row.user_id, day, clientId],
        );
        return "failed" as const;
      }
    });
    if (r === "sent") sent++;
    else if (r === "failed") failed++;
    else skipped++;
  }
  return { sent, skipped, failed };
}
