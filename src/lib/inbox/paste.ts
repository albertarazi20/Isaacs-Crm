import { costCents, PROMPT_VERSION, readLenderEmail, type ReadInput } from "../ai/readLenderEmail";
import { UserError } from "../data/mutations";
import type { DbAccess } from "../db";
import type { Reader } from "./process";
import { mapStipRequests } from "./stips";

/**
 * Import a pasted portal page (S2-15). A manager pastes the lender's text; the same reader turns it into one event
 * with quotes, code checks the quotes and the maths, and the terms land in the Review tray as a proposed update with
 * source 'pasted' — never applied by themselves, because the words came through a person's clipboard and the money
 * always waits for a click. The kill switch and the daily spend cap apply as they do to email. Everything runs as
 * the manager; the writes go through record_pasted_read (0511).
 */
export interface PastedOfferInput {
  dealId: string;
  /** The lender row the text is about; without one the update carries only the deal. */
  submissionId?: string | null;
  text: string;
}

export interface PastedOfferResult {
  proposedId: string;
  event: string;
  summary: string;
  unsupported: string[];
  problems: string[];
}

export async function importPastedOffer(args: {
  db: DbAccess;
  userId: string;
  input: PastedOfferInput;
  reader?: Reader;
}): Promise<PastedOfferResult> {
  const text = args.input.text.trim();
  if (text.length < 20)
    throw new UserError("Paste the lender's text first — a few words is not enough");
  return args.db.withUser(args.userId, async (q) => {
    // the deal must be in the pasting person's view (RLS says so); the row and funder give the reader its hints
    const d = (
      await q.query<{ id: string; client_id: string; business_name: string; who: string }>(
        `select d.id, d.client_id, c.business_name, coalesce(nullif(u.name, ''), u.email) as who
           from deals d join clients c on c.id = d.client_id, app_users u
          where d.id = $1 and u.id = app.current_user_id()`,
        [args.input.dealId],
      )
    ).rows[0];
    if (!d) throw new UserError("That deal isn't in your view");
    const s = args.input.submissionId
      ? (
          await q.query<{ id: string; funder_name: string }>(
            "select s.id, f.name as funder_name from submissions s join funders f on f.id = s.funder_id where s.id = $1 and s.deal_id = $2",
            [args.input.submissionId, d.id],
          )
        ).rows[0]
      : undefined;
    if (args.input.submissionId && !s) throw new UserError("That lender row is not on this deal");
    const settings = (
      await q.query<{
        ai_enabled: boolean;
        ai_model: string;
        ai_daily_cap_cents: number;
        spent: string;
        today: string;
      }>(
        "select ai_enabled, ai_model, ai_daily_cap_cents, app.ai_spent_today_cents()::text as spent, current_date::text as today from shop_settings",
      )
    ).rows[0];
    if (!settings?.ai_enabled) throw new UserError("The AI reader is switched off in Settings");
    if (Number(settings.spent) >= settings.ai_daily_cap_cents)
      throw new UserError(
        "Today's AI spend cap is used up — try again tomorrow or raise it in Settings",
      );
    const reader: Reader = args.reader ?? ((i, model) => readLenderEmail(i, { model }));
    const input: ReadInput = {
      from: `pasted by ${d.who}`,
      subject: `Pasted lender text for ${d.business_name}`,
      text,
      attachmentNames: [],
      expectedBusiness: d.business_name,
      expectedLender: s?.funder_name,
    };
    const out = await reader(input, settings.ai_model);
    const r = out.result;
    if (r.event === "no_change" && !r.portal_link_only)
      throw new UserError("Nothing in that text reads as a lender update");
    const payload = {
      ...(r.offer
        ? {
            amount_cents:
              r.offer.amount_dollars !== null ? Math.round(r.offer.amount_dollars * 100) : null,
            factor_rate: r.offer.factor_rate,
            payment_cents:
              r.offer.payment_dollars !== null ? Math.round(r.offer.payment_dollars * 100) : null,
            frequency: r.offer.frequency,
            term_days: r.offer.term_days,
            fees_cents:
              r.offer.fees_dollars !== null ? Math.round(r.offer.fees_dollars * 100) : null,
            position_no: r.offer.position_no,
            expires_on: r.offer.expires_on,
            buy_rate: r.offer.buy_rate,
            max_upsell_points: r.offer.max_upsell_points,
          }
        : {}),
      decline_reason: r.decline_reason,
      stips: r.stips_requested,
      stip_rows:
        r.event === "stip_requested" || r.event === "info_requested"
          ? mapStipRequests(r.stips_requested, settings.today)
          : [],
      offers_count: r.offers_count,
      portal_link_only: r.portal_link_only,
      note: r.summary,
      unsupported: out.unsupported,
      problems: out.problems,
      pasted_by: d.who,
    };
    const { rows } = await q.query<{ id: string }>(
      "select record_pasted_read($1, $2, $3::jsonb, $4::jsonb) as id",
      [
        d.id,
        s?.id ?? null,
        JSON.stringify({
          model: out.model,
          prompt_version: PROMPT_VERSION,
          input_hash: out.inputHash,
          input_tokens: out.inputTokens,
          output_tokens: out.outputTokens,
          cost_cents: costCents(out.model, out.inputTokens, out.outputTokens),
          output: r,
        }),
        JSON.stringify({
          event: r.portal_link_only && r.event === "no_change" ? "approved" : r.event,
          payload,
          evidence: r.evidence,
          confidence: r.confidence,
          summary: r.summary,
          next_step: r.portal_link_only
            ? `Offer waiting behind a link — open it and enter the terms (${r.next_step})`
            : r.next_step,
        }),
      ],
    );
    return {
      proposedId: rows[0]?.id as string,
      event: r.event,
      summary: r.summary,
      unsupported: out.unsupported,
      problems: out.problems,
    };
  });
}
