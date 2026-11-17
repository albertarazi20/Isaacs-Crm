import type { DbAccess } from "../db";
import {
  classifyReply,
  PROMPT_VERSION,
  type ClassifyInput,
  type ClassifyOutcome,
  type ReplyTag,
} from "../ai/classifyReply";
import { costCents } from "../ai/cost";

/**
 * Tag the merchant replies the inbox sync stored (S1-6). Runs after the sync on the owner connection: every reply
 * with no reply_tags row yet goes to the classifier, the result is logged in ai_runs with its cost, and
 * apply_reply_tag (0505) turns the tag into state. The AI kill switch and daily spend cap
 * (shop_settings.ai_enabled, ai_daily_cap_cents) apply. The classifier is injected so tests use a fake.
 */

export type ReplyReader = (i: ClassifyInput, model: string) => Promise<ClassifyOutcome>;

export interface TagSummary {
  read: number;
  tagged: number;
  skipped: number;
  failed: number;
  byTag: Record<ReplyTag, number>;
}

interface PendingReply {
  id: string;
  client_id: string;
  from_address: string;
  from_name: string;
  subject: string;
  text_body: string;
}

export async function tagMerchantReplies(args: {
  db: DbAccess;
  reader?: ReplyReader;
  max?: number;
}): Promise<TagSummary> {
  const s: TagSummary = {
    read: 0,
    tagged: 0,
    skipped: 0,
    failed: 0,
    byTag: { interested: 0, sending_docs: 0, not_now: 0, stop: 0, wrong_person: 0, other: 0 },
  };
  const settings = await args.db.withSystem(
    async (q) =>
      (
        await q.query<{
          ai_enabled: boolean;
          ai_model: string;
          ai_daily_cap_cents: number;
          spent: string;
        }>(
          "select ai_enabled, ai_model, ai_daily_cap_cents, app.ai_spent_today_cents()::text as spent from shop_settings",
        )
      ).rows[0],
  );
  if (!settings || !settings.ai_enabled) return s;
  const reader: ReplyReader = args.reader ?? ((i, model) => classifyReply(i, { model }));

  const pending = await args.db.withSystem(
    async (q) =>
      (
        await q.query<PendingReply>(
          `select e.id, e.client_id, e.from_address, e.from_name, e.subject, e.text_body
             from inbound_emails e
            where e.kind = 'merchant' and e.client_id is not null
              and not exists (select 1 from reply_tags r where r.email_id = e.id)
              and not exists (select 1 from ai_runs a where a.email_id = e.id and a.purpose = 'classify_reply'
                                 and a.error is not null and a.created_at > now() - interval '1 day')
              and not exists (select 1 from trashed_clients tc where tc.client_id = e.client_id)
            order by e.received_at limit $1`,
          [args.max ?? 50],
        )
      ).rows,
  );
  let spent = Number(settings.spent);

  for (const e of pending) {
    if (spent >= settings.ai_daily_cap_cents) {
      s.skipped += 1;
      continue;
    }
    const input: ClassifyInput = {
      from: `${e.from_name} <${e.from_address}>`,
      subject: e.subject,
      text: e.text_body,
    };
    try {
      const out = await reader(input, settings.ai_model);
      s.read += 1;
      const cost = costCents(out.model, out.inputTokens, out.outputTokens);
      spent += cost;
      // an unsupported tag (the words are not in the reply) is kept as "other": it changes nothing
      const tag: ReplyTag = out.supported ? out.result.tag : "other";
      await args.db.withSystem(async (q) => {
        await q.query(
          `insert into ai_runs (purpose, model, prompt_version, input_hash, input_tokens, output_tokens, cost_cents, output, email_id)
           values ('classify_reply', $1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            out.model,
            PROMPT_VERSION,
            out.inputHash,
            out.inputTokens,
            out.outputTokens,
            cost,
            JSON.stringify(out.result),
            e.id,
          ],
        );
        await q.query("select apply_reply_tag($1, $2, $3, $4, $5, $6, $7)", [
          e.id,
          tag,
          out.result.confidence,
          out.result.quote,
          out.supported,
          out.model,
          out.result.not_now_days,
        ]);
      });
      s.tagged += 1;
      s.byTag[tag] += 1;
    } catch (err) {
      s.failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      await args.db.withSystem((q) =>
        q.query(
          "insert into ai_runs (purpose, model, prompt_version, input_hash, error, email_id) values ('classify_reply', $1, $2, 'n/a', $3, $4)",
          [settings.ai_model, PROMPT_VERSION, msg, e.id],
        ),
      );
    }
  }
  return s;
}
