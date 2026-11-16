import type { Db, DbAccess } from "../db";
import {
  costCents,
  PROMPT_VERSION,
  readLenderEmail,
  type ReadInput,
  type ReadOutcome,
} from "../ai/readLenderEmail";

/**
 * Turn stored, matched lender emails into proposed updates. The reader proposes; the rules here decide:
 *   * low stakes (info/stips requested, declined with reason, docs out/in, BV, funding call, killed) apply at once
 *     when the sender passed authentication, the thread matched, confidence is high and every fact is quoted;
 *   * anything with money (approved / revised / funded) always waits for a manager;
 *   * anything unsupported or doubtful waits for a manager.
 * Everything is logged in ai_runs with its cost. A kill switch and a daily spend cap live in shop_settings.
 */

export interface ProcessSummary {
  read: number;
  applied: number;
  proposed: number;
  skipped: number;
  failed: number;
}

interface Pending {
  id: string;
  deal_id: string | null;
  submission_id: string | null;
  client_id: string | null;
  from_address: string;
  from_name: string;
  subject: string;
  text_body: string;
  attachment_names: string[];
  spf_pass: boolean | null;
  dkim_pass: boolean | null;
  matched_by: string | null;
  kind: string;
  business_name: string | null;
  funder_name: string | null;
}

export type Reader = (i: ReadInput, model: string) => Promise<ReadOutcome>;

const LOW_STAKES = new Set([
  "info_requested",
  "stip_requested",
  "declined",
  "docs_out",
  "contracts_in",
  "bv_done",
  "funding_call_done",
  "killed",
]);

export async function processInbox(args: {
  db: DbAccess;
  reader?: Reader;
  max?: number;
}): Promise<ProcessSummary> {
  const s: ProcessSummary = { read: 0, applied: 0, proposed: 0, skipped: 0, failed: 0 };
  const settings = await args.db.withSystem(
    async (q) =>
      (
        await q.query<{
          ai_enabled: boolean;
          ai_model: string;
          ai_daily_cap_cents: number;
          ai_auto_apply_low_stakes: boolean;
          spent: string;
        }>(
          "select ai_enabled, ai_model, ai_daily_cap_cents, ai_auto_apply_low_stakes, app.ai_spent_today_cents()::text as spent from shop_settings",
        )
      ).rows[0],
  );
  if (!settings || !settings.ai_enabled) return s;
  const reader: Reader = args.reader ?? ((i, model) => readLenderEmail(i, { model }));

  const pending = await args.db.withSystem(
    async (q) =>
      (
        await q.query<Pending>(
          `select e.id, e.deal_id, e.submission_id, e.client_id, e.from_address, e.from_name, e.subject, e.text_body, e.attachment_names,
                  e.spf_pass, e.dkim_pass, e.matched_by, e.kind, c.business_name, f.name as funder_name
             from inbound_emails e
             left join clients c on c.id = e.client_id
             left join funders f on f.id = e.funder_id
            where e.processed_at is null and e.kind in ('lender', 'merchant')
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
    // a merchant reply needs no model: the sync already stopped the sequence; mark it and move on
    if (e.kind === "merchant" || !e.deal_id) {
      await args.db.withSystem((q) =>
        q.query("update inbound_emails set processed_at = now() where id = $1", [e.id]),
      );
      s.skipped += 1;
      continue;
    }
    try {
      const input: ReadInput = {
        from: `${e.from_name} <${e.from_address}>`,
        subject: e.subject,
        text: e.text_body,
        attachmentNames: e.attachment_names,
        expectedBusiness: e.business_name ?? undefined,
        expectedLender: e.funder_name ?? undefined,
      };
      const out = await reader(input, settings.ai_model);
      s.read += 1;
      const cost = costCents(out.model, out.inputTokens, out.outputTokens);
      spent += cost;
      await args.db.withSystem(async (q) => {
        await q.query(
          `insert into ai_runs (purpose, model, prompt_version, input_hash, input_tokens, output_tokens, cost_cents, output, email_id, deal_id)
           values ('read_lender_email', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            out.model,
            PROMPT_VERSION,
            out.inputHash,
            out.inputTokens,
            out.outputTokens,
            cost,
            JSON.stringify(out.result),
            e.id,
            e.deal_id,
          ],
        );
        const r = out.result;
        if (r.event === "no_change" && !r.portal_link_only) {
          await q.query("update inbound_emails set processed_at = now() where id = $1", [e.id]);
          s.skipped += 1;
          return;
        }
        const payload = {
          ...(r.offer
            ? {
                amount_cents:
                  r.offer.amount_dollars !== null ? Math.round(r.offer.amount_dollars * 100) : null,
                factor_rate: r.offer.factor_rate,
                payment_cents:
                  r.offer.payment_dollars !== null
                    ? Math.round(r.offer.payment_dollars * 100)
                    : null,
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
          offers_count: r.offers_count,
          portal_link_only: r.portal_link_only,
          note: r.summary,
          unsupported: out.unsupported,
          problems: out.problems,
        };
        const authenticated = e.spf_pass !== false && e.dkim_pass !== false;
        const certain =
          e.matched_by === "thread" ||
          e.matched_by === "reply_headers" ||
          e.matched_by === "deal_token";
        const clean =
          out.unsupported.length === 0 && out.problems.length === 0 && r.confidence >= 0.8;
        const lowStakes = LOW_STAKES.has(r.event);
        const auto =
          settings.ai_auto_apply_low_stakes &&
          lowStakes &&
          authenticated &&
          certain &&
          clean &&
          !r.portal_link_only;
        const { rows } = await q.query<{ id: string }>(
          `insert into proposed_updates (email_id, deal_id, submission_id, event, payload, evidence, confidence, status, summary, next_step)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
          [
            e.id,
            e.deal_id,
            e.submission_id,
            r.portal_link_only && r.event === "no_change" ? "approved" : r.event,
            JSON.stringify(payload),
            JSON.stringify(r.evidence),
            r.confidence,
            auto ? "auto" : "proposed",
            r.summary,
            r.portal_link_only
              ? `Offer waiting behind a link — open it and enter the terms (${r.next_step})`
              : r.next_step,
          ],
        );
        const updateId = rows[0]?.id;
        if (auto && updateId) {
          await q.query("select apply_proposed_update($1)", [updateId]);
          s.applied += 1;
        } else {
          s.proposed += 1;
          // a manager task on the deal so it shows in the Dashboard's list
          if (e.deal_id)
            await q.query(
              `update deals set blocker = $2 where id = $1 and (blocker = '' or blocker like 'Review:%')`,
              [e.deal_id, `Review: ${r.summary.slice(0, 120)}`],
            );
        }
        // one timeline line per email, linked to the email
        await q.query(
          `insert into activities (user_id, client_id, kind, body)
           select d.user_id, d.client_id, 'system', $2 from deals d where d.id = $1`,
          [e.deal_id, `${auto ? "" : "[needs review] "}${r.summary}`],
        );
        await q.query("update inbound_emails set processed_at = now() where id = $1", [e.id]);
      });
    } catch (err) {
      s.failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      await args.db.withSystem((q) =>
        q.query(
          `insert into ai_runs (purpose, model, prompt_version, input_hash, error, email_id, deal_id) values ('read_lender_email', $1, $2, 'n/a', $3, $4, $5)`,
          [settings.ai_model, PROMPT_VERSION, msg, e.id, e.deal_id],
        ),
      );
    }
  }
  return s;
}

/** The Review tray for managers: proposed updates with their email and deal, newest first. */
export async function listProposed(q: Db): Promise<
  {
    id: string;
    event: string;
    summary: string;
    next_step: string;
    confidence: number;
    payload: Record<string, unknown>;
    evidence: { field: string; quote: string }[];
    created_at: string;
    deal_id: string;
    deal_number: number;
    business_name: string;
    funder_name: string | null;
    subject: string;
    from_address: string;
  }[]
> {
  const { rows } = await q.query(
    `select p.id, p.event, p.summary, p.next_step, p.confidence, p.payload, p.evidence, p.created_at, p.deal_id,
            d.number as deal_number, c.business_name, f.name as funder_name, e.subject, e.from_address
       from proposed_updates p
       join deals d on d.id = p.deal_id join clients c on c.id = d.client_id
       left join inbound_emails e on e.id = p.email_id
       left join submissions s on s.id = p.submission_id left join funders f on f.id = s.funder_id
      where p.status = 'proposed' order by p.created_at desc limit 200`,
  );
  return rows;
}
