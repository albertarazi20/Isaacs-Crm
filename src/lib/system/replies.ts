/**
 * System-side handling of what merchants and mail providers send back: replies (Gmail sync or Resend inbound),
 * bounces and complaints (Resend webhooks), unsubscribes (the footer link). Everything lands in SQL functions so the
 * rules live in one place; this file is the glue and the alerts.
 */
import type { Db, DbAccess } from "../db";
import { authResults, senderVerified } from "../inbox/gmailRead";
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
 * A From header is forgeable. An inbound message counts as the merchant's only when SPF or DKIM passes aligned with the From domain, or when
 * it replies to an email the CRM sent that merchant (In-Reply-To / References name one of our provider ids).
 */
async function inboundVerified(
  q: Db,
  d: Record<string, unknown>,
  clientId: string,
  from: string,
): Promise<boolean> {
  const auth = authResults(headerOf(d, "authentication-results") || null, addressOf(from));
  if (senderVerified(auth)) return true;
  const refs = `${headerOf(d, "in-reply-to")} ${headerOf(d, "references")}`;
  if (refs.trim() === "") return false;
  const { rows } = await q.query<{ provider_id: string }>(
    "select provider_id from outbox where client_id = $1 and status = 'sent' and provider_id is not null",
    [clientId],
  );
  return rows.some((r) => r.provider_id !== "" && refs.includes(r.provider_id));
}

/**
 * A STOP from the merchant's exact address whose sender check failed (a forwarder, a misaligned third-party sender, no
 * Authentication-Results). It is applied anyway: a missed STOP is a compliance problem, a spoofed one costs one lead.
 * Nothing else about the mail is trusted (no reply flag, no attachment filing). The timeline says why the opt-out
 * happened so the rep can undo it if it was forged. Returns false when the merchant was already opted out (by their
 * own wish; a rep's hand stop does not count).
 */
export async function applyUnverifiedStop(
  q: Db,
  clientId: string,
  from: string,
  snippet: string,
): Promise<boolean> {
  // "Already opted out" means the merchant's own wish or a bounce, not a rep's hand stop (0580): that one does not
  // record what the merchant wants, so a STOP after it still runs the opt-out and becomes the merchant's own
  const { rows } = await q.query<{ user_id: string; email_opt_out: boolean }>(
    "select user_id, (email_opt_out and not app.hand_stopped_only(id)) as email_opt_out from clients where id = $1",
    [clientId],
  );
  const c = rows[0];
  if (!c || c.email_opt_out) return false;
  await q.query("select opt_out($1, 'email', 'stop_reply', $2)", [clientId, snippet.slice(0, 200)]);
  await q.query("select stop_enrollment($1, 'opted_out')", [clientId]);
  await q.query(
    "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
    [
      c.user_id,
      clientId,
      `Opted out of email from an unverified sender: a STOP from ${from.toLowerCase()} failed the sender check (forwarded or misaligned mail), so it was applied anyway. If it was not them, turn email back on for this merchant.`,
    ],
  );
  return true;
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

/**
 * One Resend event. Stored first (idempotent on the provider's event id), then applied. Unknown types are kept and
 * marked ignored, so a new event type shows up in the table before anyone writes code for it.
 */
export async function handleResendEvent(
  db: DbAccess,
  eventId: string,
  evt: ResendEvent,
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
    // A failing statement aborts a Postgres transaction, so the error is caught under a savepoint: rolled back to it,
    // the transaction can still store the error on the event instead of the whole route failing and Resend retrying.
    await q.query("savepoint handle_event");
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
          // inbound on the automation domain: a merchant answering a sequence email; anyone else is only kept in
          // webhook_events
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
            result = "received:unknown_sender";
            break;
          }
          if (!(await inboundVerified(q, d as Record<string, unknown>, clientId, from))) {
            result =
              isStopMessage(subject, text) &&
              (await applyUnverifiedStop(q, clientId, addressOf(from), text))
                ? "received:unverified_stop"
                : "received:unverified_sender";
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
      await q.query("release savepoint handle_event");
    } catch (e) {
      await q.query("rollback to savepoint handle_event");
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

/** `already` is true once the merchant has opted out themselves; a rep's hand stop (0580) is not their wish, so the link still works. */
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
      `select c.id, c.business_name, c.email, (c.email_opt_out and not app.hand_stopped_only(c.id)) as email_opt_out,
              (select shop_name from shop_settings) as shop_name
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
      } catch (e) {
        console.error(
          `reply alert for client ${clientId}:`,
          e instanceof Error ? e.message : String(e),
        );
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
