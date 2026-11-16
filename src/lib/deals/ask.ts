import { ASK_PROMPT_VERSION, askDealQuestion, type AskEvent, type Asker } from "../ai/askDeal";
import { costCents } from "../ai/readLenderEmail";
import { UserError } from "../data/mutations";
import type { DbAccess } from "../db";
import { listDealTimeline, type TimelineEvent } from "./timeline";

/**
 * Ask a question about a deal in plain words (plan §7). Runs as the person, so the model only ever sees a deal the
 * person can see. The kill switch and the daily spend cap apply as they do to the lender reader; the run is logged
 * through record_ai_run (0530). The answer comes back with only the citations code could verify.
 */
export interface DealAnswer {
  answer: string;
  cannotAnswer: boolean;
  confidence: "high" | "medium" | "low";
  /** Verified only: each points at a timeline event the person can open. */
  citations: {
    ref_type: TimelineEvent["ref_type"];
    ref_id: string;
    at: string;
    title: string;
    quote: string;
  }[];
  /** How many of the model's citations were dropped by the check. */
  dropped: number;
  model: string;
}

export async function askDeal(args: {
  db: DbAccess;
  userId: string;
  dealId: string;
  question: string;
  asker?: Asker;
}): Promise<DealAnswer> {
  const question = args.question.trim();
  if (question.length < 3) throw new UserError("Ask a question first");
  if (question.length > 500) throw new UserError("Keep the question under 500 characters");
  return args.db.withUser(args.userId, async (q) => {
    const d = (
      await q.query<{ business_name: string; status: string; blocker: string }>(
        `select c.business_name, app.deal_status(d) as status, d.blocker
           from deals d join clients c on c.id = d.client_id where d.id = $1`,
        [args.dealId],
      )
    ).rows[0];
    if (!d) throw new UserError("That deal isn't in your view");
    const settings = (
      await q.query<{
        ai_enabled: boolean;
        ai_model: string;
        ai_daily_cap_cents: number;
        spent: string;
      }>(
        "select ai_enabled, ai_model, ai_daily_cap_cents, app.ai_spent_today_cents()::text as spent from shop_settings",
      )
    ).rows[0];
    if (!settings?.ai_enabled) throw new UserError("The AI is switched off in Settings");
    if (Number(settings.spent) >= settings.ai_daily_cap_cents)
      throw new UserError(
        "Today's AI spend cap is used up — try again tomorrow or raise it in Settings",
      );
    const timeline = await listDealTimeline(q, args.dealId, 150);
    const events: AskEvent[] = timeline.map((e, i) => ({
      ref: `e${i + 1}`,
      at: e.at.slice(0, 16).replace("T", " "),
      kind: e.kind,
      actor: e.actor,
      title: e.title,
      detail: e.detail,
    }));
    const asker: Asker = args.asker ?? ((i, model) => askDealQuestion(i, { model }));
    const out = await asker(
      { question, businessName: d.business_name, status: d.status, blocker: d.blocker, events },
      settings.ai_model,
    );
    await q.query("select record_ai_run('ask_deal', $1, $2::jsonb)", [
      args.dealId,
      JSON.stringify({
        model: out.model,
        prompt_version: ASK_PROMPT_VERSION,
        input_hash: out.inputHash,
        input_tokens: out.inputTokens,
        output_tokens: out.outputTokens,
        cost_cents: costCents(out.model, out.inputTokens, out.outputTokens),
        output: { question, ...out.result, verified: out.verified.length, dropped: out.dropped },
      }),
    ]);
    const byRef = new Map(events.map((e, i) => [e.ref, timeline[i] as TimelineEvent]));
    const citations = out.verified.flatMap((c) => {
      const e = byRef.get(c.ref);
      return e
        ? [{ ref_type: e.ref_type, ref_id: e.ref_id, at: e.at, title: e.title, quote: c.quote }]
        : [];
    });
    const unsupported = citations.length === 0 && !out.result.cannot_answer;
    return {
      answer: out.result.answer,
      cannotAnswer: out.result.cannot_answer,
      confidence: unsupported ? "low" : out.result.confidence,
      citations,
      dropped: out.dropped,
      model: out.model,
    };
  });
}
