import type { Db, DbAccess } from "../db";
import { documentStore } from "../docs/storage";
import { fileEmailAttachment } from "../docs/upload";
import { todayIn } from "../mca/dates";
import { isStopMessage } from "../messaging/stop";
import { accessTokenFor } from "../email/gmail";
import { env } from "../env";
import { authResults, matchEmail, type Candidate } from "./match";
import {
  getAttachment,
  getMessage,
  listHistory,
  listMessages,
  parseAddress,
  splitMessageIds,
  type GmailMessageMeta,
} from "./gmailRead";

/**
 * Pull new mail from each connected mailbox that may be read (managers / ops with the 'mail' grant), store it,
 * and match it to a deal by code. Reading the email with the AI is the next step (processInbox), so a sync never
 * waits on the model and a model outage never loses mail.
 */

export interface InboxSyncSummary {
  mailboxes: number;
  fetched: number;
  stored: number;
  matched: number;
  failed: { userId: string; error: string }[];
  /** Merchants who wrote back this run, for the rep alert. */
  merchantReplies: string[];
  /** Attachments filed into Documents. */
  filed: number;
}

type TokenFor = (userId: string) => Promise<string>;

export function productionMailTokenFor(db: DbAccess): TokenFor {
  return async (userId) => {
    const e = env();
    if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) throw new Error("Google is not configured");
    const row = await db.withSystem(async (q) => {
      const { rows } = await q.query<{
        google_email: string;
        refresh_token_enc: string;
        can_read_mail: boolean;
      }>(
        "select google_email, refresh_token_enc, can_read_mail from gmail_connections where user_id = $1 and status = 'ok'",
        [userId],
      );
      return rows[0];
    });
    if (!row) throw new Error("Google is not connected");
    if (!row.can_read_mail)
      throw new Error("Google was connected without inbox access — reconnect with inbox reading");
    return accessTokenFor(
      { refreshTokenEnc: row.refresh_token_enc, googleEmail: row.google_email },
      {
        clientId: e.GOOGLE_CLIENT_ID,
        clientSecret: e.GOOGLE_CLIENT_SECRET,
        tokenEncKey: e.TOKEN_ENC_KEY,
      },
    );
  };
}

/** Open submissions across the shop, with what the ladder needs. Loaded once per sync. */
export async function loadCandidates(q: Db): Promise<Candidate[]> {
  const { rows } = await q.query<Candidate>(
    `select s.id as "submissionId", d.id as "dealId", c.id as "clientId", f.id as "funderId",
            s.gmail_thread_id as "threadId", s.gmail_message_id as "messageId", d.number as "dealNumber",
            c.business_name as "businessName", c.dba,
            lower(split_part(f.submission_email, '@', 2)) as "funderDomain"
       from submissions s
       join deals d on d.id = s.deal_id
       join clients c on c.id = s.client_id
       join funders f on f.id = s.funder_id
      where d.outcome = 'open' or d.closed_at > now() - interval '60 days'`,
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
    matched: 0,
    failed: [],
    merchantReplies: [],
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
  const candidates = await args.db.withSystem(loadCandidates);
  const funderDomains = new Set(candidates.map((c) => c.funderDomain).filter(Boolean));

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
        // first sync or an expired cursor: a bounded search (lender domains + the deal token), newest first
        const days = args.lookbackDays ?? 14;
        const doms = [...funderDomains].slice(0, 30).map((d) => `from:${d}`);
        const q = `newer_than:${days}d (${[...doms, 'subject:"[D-"'].join(" OR ")})`;
        metas = await listMessages(token, q, args.fetchImpl, args.maxPerMailbox ?? 200);
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
        const auth = authResults(m.headers["authentication-results"] ?? null);
        const match = matchEmail(
          {
            threadId: m.threadId,
            inReplyTo: m.headers["in-reply-to"] ?? null,
            references: splitMessageIds(m.headers["references"]),
            fromAddress: from.address,
            subject: m.headers["subject"] ?? "",
            text: m.text,
          },
          candidates,
        );
        // a merchant replying on a sequence thread: match by the outbox we sent (same thread) → stop the chase
        const merchant = match
          ? null
          : await args.db.withSystem(async (q) => {
              const { rows } = await q.query<{ client_id: string }>(
                `select c.id as client_id from clients c where lower(c.email) = $1 and c.email <> '' limit 1`,
                [from.address],
              );
              return rows[0]?.client_id ?? null;
            });
        await args.db.withSystem(async (q) => {
          await q.query(
            `insert into inbound_emails (mailbox_user_id, gmail_id, gmail_thread_id, message_id, in_reply_to, references_ids, from_address, from_name,
                                         to_addresses, subject, snippet, text_body, attachment_names, received_at, spf_pass, dkim_pass,
                                         deal_id, submission_id, client_id, funder_id, matched_by, kind)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
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
              match?.candidate.dealId ?? null,
              match?.candidate.submissionId ?? null,
              match?.candidate.clientId ?? merchant,
              match?.candidate.funderId ?? null,
              match ? match.by : merchant ? "merchant_reply" : "none",
              match
                ? "lender"
                : merchant
                  ? "merchant"
                  : funderDomains.has(from.address.split("@")[1] ?? "")
                    ? "lender"
                    : "unknown",
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
          }
        });
        // attachments on a matched email are documents: statements a merchant forwards, contracts a lender sends
        const owner = match?.candidate.clientId ?? merchant;
        if (owner && m.attachments.length > 0) {
          const store = documentStore(env());
          for (const a of m.attachments.slice(0, 10)) {
            if (a.size > 25 * 1024 * 1024) continue;
            try {
              const bytes = await getAttachment(token, m.id, a.attachmentId, args.fetchImpl);
              const filed = await fileEmailAttachment(args.db, store, {
                clientId: owner,
                dealId: match?.candidate.dealId ?? null,
                filename: a.filename,
                contentType: a.mimeType,
                bytes,
                today: todayIn("America/New_York", args.now),
              });
              if (filed && !filed.duplicate) summary.filed += 1;
            } catch (err) {
              summary.failed.push({
                userId: mb.user_id,
                error: `attachment ${a.filename}: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          }
        }
        summary.stored += 1;
        if (match) summary.matched += 1;
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
