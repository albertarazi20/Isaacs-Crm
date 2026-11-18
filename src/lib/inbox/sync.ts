import type { Db, DbAccess } from "../db";
import { documentStore } from "../docs/storage";
import { fileEmailAttachment } from "../docs/upload";
import { todayIn } from "../mca/dates";
import { isStopMessage } from "../messaging/stop";
import { env } from "../env";
import { googleAccessTokenFor } from "../system/gmail";
import { applyUnverifiedStop } from "../system/replies";
import {
  authResults,
  senderVerified,
  getAttachment,
  getMessage,
  listHistory,
  listMessages,
  parseAddress,
  splitMessageIds,
  type GmailMessageMeta,
} from "./gmailRead";

/**
 * Pull new mail from each connected mailbox that may be read (managers / ops with the 'mail' grant) and keep what a
 * merchant wrote: the reply stops their sequence and tells the rep, an attachment becomes a document. Mail from
 * anyone else is not stored. Tagging a reply with the AI is a later step (tagMerchantReplies), so a sync never
 * waits on the model and a model outage never loses mail.
 */

export interface InboxSyncSummary {
  mailboxes: number;
  fetched: number;
  stored: number;
  failed: { userId: string; error: string }[];
  /** Merchants who wrote back this run, for the rep alert. */
  merchantReplies: string[];
  /** same-address senders that failed SPF/DKIM and were not treated as the merchant */
  unverified: number;
  /** Attachments filed into Documents. */
  filed: number;
}

type TokenFor = (userId: string) => Promise<string>;

/** An access token for reading a user's inbox. The refresh token stays inside lib/system. */
export function productionMailTokenFor(): TokenFor {
  return (userId) => googleAccessTokenFor(userId, "mail");
}

export interface MailboxSyncRow {
  user_id: string;
  name: string;
  email: string;
  google_email: string;
  can_read_mail: boolean;
  connection_status: string;
  last_synced_at: string | null;
  last_error: string | null;
  messages_seen: number;
  /** A Gmail history cursor is on file: the next sync is incremental, not a search. */
  has_cursor: boolean;
}

/**
 * Last synced per mailbox, for the Settings page (S2-18): a person's own mailbox, every mailbox for a manager. The
 * connection row holds the refresh token, so the read goes through mailbox_sync_status() (0515), which never returns it.
 */
export async function mailboxSyncStatus(q: Db): Promise<MailboxSyncRow[]> {
  const { rows } = await q.query<MailboxSyncRow>(
    "select user_id, name, email, google_email, can_read_mail, connection_status, last_synced_at::text as last_synced_at, last_error, messages_seen, has_cursor from mailbox_sync_status()",
  );
  return rows;
}

export async function syncInbox(args: {
  db: DbAccess;
  tokenFor: TokenFor;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** First sync: how far back to look. */
  lookbackDays?: number;
  maxPerMailbox?: number;
}): Promise<InboxSyncSummary> {
  const summary: InboxSyncSummary = {
    mailboxes: 0,
    fetched: 0,
    stored: 0,
    failed: [],
    merchantReplies: [],
    unverified: 0,
    filed: 0,
  };
  const mailboxes = await args.db.withSystem(
    async (q) =>
      (
        await q.query<{ user_id: string; history_id: string | null }>(
          `select g.user_id, m.history_id from gmail_connections g
             left join mail_sync_state m on m.user_id = g.user_id
            where g.status = 'ok' and g.can_read_mail`,
        )
      ).rows,
  );
  summary.mailboxes = mailboxes.length;

  for (const mb of mailboxes) {
    try {
      const token = await args.tokenFor(mb.user_id);
      let metas: GmailMessageMeta[] = [];
      let newHistoryId: string | null = null;
      if (mb.history_id) {
        const h = await listHistory(token, mb.history_id, args.fetchImpl);
        if (h) {
          metas = h.added;
          newHistoryId = h.historyId;
        }
      }
      if (!mb.history_id || (metas.length === 0 && newHistoryId === null)) {
        // first sync or an expired cursor: a bounded search of the inbox, newest first
        const days = args.lookbackDays ?? 14;
        metas = await listMessages(
          token,
          `newer_than:${days}d in:inbox`,
          args.fetchImpl,
          args.maxPerMailbox ?? 200,
        );
      }
      summary.fetched += metas.length;
      for (const meta of metas) {
        const exists = await args.db.withSystem(
          async (q) =>
            (
              await q.query(
                "select 1 from inbound_emails where mailbox_user_id = $1 and gmail_id = $2",
                [mb.user_id, meta.id],
              )
            ).rowCount === 1,
        );
        if (exists) continue;
        const m = await getMessage(token, meta.id, args.fetchImpl);
        if (!newHistoryId || BigInt(m.historyId) > BigInt(newHistoryId)) newHistoryId = m.historyId;
        const from = parseAddress(m.headers["from"]);
        const auth = authResults(m.headers["authentication-results"] ?? null, from.address);
        // Only a merchant's mail is kept; anything else in the mailbox is none of the CRM's business. A From header
        // is forgeable: the sender counts as the merchant only when SPF or DKIM passes aligned with the From domain, so one spoofed email
        // cannot stop a sequence, suppress an address shop-wide or tick a statement as received.
        const sameAddress = await args.db.withSystem(async (q) => {
          const { rows } = await q.query<{ client_id: string }>(
            `select c.id as client_id from clients c where lower(c.email) = $1 and c.email <> ''
               and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
              order by c.created_at desc limit 1`,
            [from.address],
          );
          return rows[0]?.client_id ?? null;
        });
        if (!sameAddress) continue;
        const merchant = senderVerified(auth) ? sameAddress : null;
        if (!merchant) summary.unverified += 1;
        await args.db.withSystem(async (q) => {
          await q.query(
            `insert into inbound_emails (mailbox_user_id, gmail_id, gmail_thread_id, message_id, in_reply_to, references_ids, from_address, from_name,
                                         to_addresses, subject, snippet, text_body, attachment_names, received_at, spf_pass, dkim_pass,
                                         client_id, matched_by, kind)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
             on conflict (mailbox_user_id, gmail_id) do nothing`,
            [
              mb.user_id,
              m.id,
              m.threadId,
              m.headers["message-id"] ?? null,
              m.headers["in-reply-to"] ?? null,
              splitMessageIds(m.headers["references"]),
              from.address,
              from.name,
              (m.headers["to"] ?? "")
                .split(",")
                .map((x) => parseAddress(x).address)
                .filter(Boolean),
              m.headers["subject"] ?? "",
              m.snippet,
              m.text,
              m.attachmentNames,
              new Date(m.internalDate).toISOString(),
              auth.spf,
              auth.dkim,
              sameAddress,
              merchant ? "merchant_reply" : "none",
              merchant ? "merchant" : "unknown",
            ],
          );
          if (merchant) {
            await q.query("select record_merchant_reply($1, $2, $3, $4, $5)", [
              merchant,
              m.headers["subject"] ?? "",
              m.snippet,
              from.address,
              isStopMessage(m.headers["subject"] ?? "", m.text),
            ]);
            summary.merchantReplies.push(merchant);
          } else if (isStopMessage(m.headers["subject"] ?? "", m.text)) {
            // not proven to be the merchant, but a STOP is honoured either way: the opt-out is the safe side of a forgery
            await applyUnverifiedStop(q, sameAddress, from.address, m.snippet);
          }
        });
        // attachments on a merchant's email are documents: the statements they forward
        if (merchant && m.attachments.length > 0) {
          const store = documentStore(env());
          // anything that is not filed is written on the merchant's timeline: the email is marked as read, so no later
          // sync looks at it again, and the rep must know to open the attachment in Gmail
          const notFiled: string[] = [];
          for (const a of m.attachments.slice(0, 10)) {
            if (a.size > 25 * 1024 * 1024) {
              notFiled.push(`${a.filename} (over 25 MB)`);
              continue;
            }
            try {
              const bytes = await getAttachment(token, m.id, a.attachmentId, args.fetchImpl);
              const filed = await fileEmailAttachment(args.db, store, {
                clientId: merchant,
                filename: a.filename,
                contentType: a.mimeType,
                bytes,
                today: todayIn("America/New_York", args.now),
              });
              if (filed && !filed.duplicate) summary.filed += 1;
            } catch (err) {
              const why = err instanceof Error ? err.message : String(err);
              notFiled.push(`${a.filename} (${why})`);
              summary.failed.push({
                userId: mb.user_id,
                error: `attachment ${a.filename}: ${why}`,
              });
            }
          }
          if (m.attachments.length > 10)
            notFiled.push(`${m.attachments.length - 10} more attachment(s) past the first 10`);
          if (notFiled.length > 0)
            await args.db.withSystem((q) =>
              q.query(
                "insert into activities (user_id, client_id, kind, body) values ($1, $2, 'system', $3)",
                [
                  mb.user_id,
                  merchant,
                  `Not filed from the merchant's email "${m.headers["subject"] ?? ""}": ${notFiled.join("; ")}. Open the email in Gmail to get them.`,
                ],
              ),
            );
        }
        summary.stored += 1;
      }
      await args.db.withSystem((q) =>
        q.query(
          `insert into mail_sync_state (user_id, history_id, last_synced_at, last_error, messages_seen)
           values ($1, $2, now(), null, $3)
           on conflict (user_id) do update set history_id = coalesce(excluded.history_id, mail_sync_state.history_id),
             last_synced_at = now(), last_error = null, messages_seen = mail_sync_state.messages_seen + excluded.messages_seen`,
          [mb.user_id, newHistoryId, metas.length],
        ),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      summary.failed.push({ userId: mb.user_id, error: msg });
      await args.db.withSystem((q) =>
        q.query(
          `insert into mail_sync_state (user_id, last_error) values ($1, $2)
           on conflict (user_id) do update set last_error = excluded.last_error`,
          [mb.user_id, msg],
        ),
      );
    }
  }
  return summary;
}
