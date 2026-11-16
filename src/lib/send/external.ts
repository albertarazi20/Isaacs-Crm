import type { DbAccess } from "../db";
import { getMessage, listMessages, parseAddress } from "../inbox/gmailRead";
import { mailboxFor } from "./worker";

/**
 * Mail sent outside the CRM counts toward the cap (plan §11.1, S1-1). Google locks a mailbox on everything that
 * leaves it, not only what the engine sent, so this job reads each connected mailbox's Sent mail since its
 * watermark and writes a send_ledger row (source = 'external') for every message the CRM did not send itself.
 * app.mailbox_sent_24h counts every ledger row, so the worker's cap and the fuel gauge see them at once.
 * The reader is injected: Gmail in production (through src/lib/inbox/gmailRead.ts), a fake in tests.
 */

export interface SentMessage {
  id: string;
  /** Gmail internalDate, milliseconds since the epoch. */
  internalDate: number;
  headers: Record<string, string>;
}

export interface SentReader {
  /** Ids of Sent messages newer than `afterEpochSeconds`, newest first. */
  listSent(token: string, afterEpochSeconds: number, max: number): Promise<{ id: string }[]>;
  getSent(token: string, id: string): Promise<SentMessage>;
}

export function gmailSentReader(fetchImpl: typeof fetch = fetch): SentReader {
  return {
    listSent: (token, after, max) => listMessages(token, `in:sent after:${after}`, fetchImpl, max),
    getSent: async (token, id) => {
      const m = await getMessage(token, id, fetchImpl);
      return { id: m.id, internalDate: m.internalDate, headers: m.headers };
    },
  };
}

export interface ExternalSendsSummary {
  mailboxes: number;
  seen: number;
  recorded: number;
  /** Messages the CRM sent itself (already in the ledger through the outbox). */
  crm: number;
  failed: { userId: string; error: string }[];
}

type TokenFor = (userId: string) => Promise<string>;

/** First read: how far back to look. The cap is a rolling 24 hours, so a day is all that matters. */
const FIRST_LOOKBACK_MS = 24 * 3_600_000;

export async function recordExternalSends(args: {
  db: DbAccess;
  tokenFor: TokenFor;
  read?: SentReader;
  now?: Date;
  maxPerMailbox?: number;
}): Promise<ExternalSendsSummary> {
  const now = args.now ?? new Date();
  const read = args.read ?? gmailSentReader();
  const summary: ExternalSendsSummary = { mailboxes: 0, seen: 0, recorded: 0, crm: 0, failed: [] };
  const mailboxes = await args.db.withSystem(
    async (q) =>
      (
        await q.query<{ user_id: string; google_email: string; last_internal_date: string }>(
          `select g.user_id, g.google_email, coalesce(s.last_internal_date, 0)::text as last_internal_date
             from gmail_connections g left join mailbox_sent_sync s on s.user_id = g.user_id
            where g.status = 'ok' and g.can_read_mail`,
        )
      ).rows,
  );
  summary.mailboxes = mailboxes.length;

  for (const mb of mailboxes) {
    try {
      const token = await args.tokenFor(mb.user_id);
      const watermark = Number(mb.last_internal_date);
      const since = watermark > 0 ? watermark : now.getTime() - FIRST_LOOKBACK_MS;
      const metas = await read.listSent(token, Math.floor(since / 1000), args.maxPerMailbox ?? 200);
      summary.seen += metas.length;
      let newest = watermark;
      for (const meta of metas) {
        const m = await read.getSent(token, meta.id);
        if (m.internalDate <= watermark) continue;
        if (m.internalDate > newest) newest = m.internalDate;
        const to = parseAddress((m.headers["to"] ?? "").split(",")[0]).address;
        await args.db.withSystem(async (q) => {
          const own = await q.query(
            "select 1 from outbox where provider = 'gmail' and provider_id = $1",
            [m.id],
          );
          if (own.rowCount) {
            summary.crm += 1;
            return;
          }
          const limit = mb.google_email.toLowerCase().endsWith("@gmail.com") ? 500 : 2000;
          const mailboxId = await mailboxFor(q, "gmail", mb.user_id, mb.google_email, limit);
          const client = to
            ? (
                await q.query<{ id: string }>(
                  `select c.id from clients c where lower(c.email) = $1 and c.email <> ''
                     and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
                    order by (c.user_id = $2) desc, c.created_at desc limit 1`,
                  [to, mb.user_id],
                )
              ).rows[0]?.id
            : undefined;
          const ins = await q.query(
            `insert into send_ledger (mailbox_id, client_id, lane, source, sent_at, provider_id)
             values ($1, $2, 'manual', 'external', $3, $4)
             on conflict (mailbox_id, provider_id) where provider_id is not null do nothing`,
            [mailboxId, client ?? null, new Date(m.internalDate).toISOString(), m.id],
          );
          if (ins.rowCount) summary.recorded += 1;
        });
      }
      await args.db.withSystem((q) =>
        q.query(
          `insert into mailbox_sent_sync (user_id, last_internal_date, last_synced_at, last_error, messages_seen)
           values ($1, $2, $3, null, $4)
           on conflict (user_id) do update set last_internal_date = greatest(mailbox_sent_sync.last_internal_date, excluded.last_internal_date),
             last_synced_at = excluded.last_synced_at, last_error = null,
             messages_seen = mailbox_sent_sync.messages_seen + excluded.messages_seen`,
          [mb.user_id, newest, now.toISOString(), metas.length],
        ),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      summary.failed.push({ userId: mb.user_id, error: msg });
      await args.db.withSystem((q) =>
        q.query(
          `insert into mailbox_sent_sync (user_id, last_error) values ($1, $2)
           on conflict (user_id) do update set last_error = excluded.last_error`,
          [mb.user_id, msg],
        ),
      );
    }
  }
  return summary;
}
