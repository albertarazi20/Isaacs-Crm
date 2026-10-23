import type { Db } from "../db";
import { UserError } from "../data/mutations";
import type { UserContext } from "../data/types";
import type { CommissionReceivedInput, TermsUpdateInput } from "./schemas";

/** "2026-10-27T14:30" typed in Isaac's time zone → the real instant. */
async function localToInstant(q: Db, local: string, timezone: string): Promise<Date> {
  const { rows } = await q.query<{ t: Date }>("select ($1::timestamp at time zone $2) as t", [
    local,
    timezone,
  ]);
  const t = rows[0]?.t;
  if (!t) throw new UserError("That date and time isn't valid");
  return t;
}

/**
 * The JSON update_funding_terms() takes, from a validated form. A key the form did not send is left out, so the
 * function leaves that column alone; null is sent as null and clears it. Exported so a test can pin the exact keys.
 */
export async function termsJson(
  q: Db,
  input: TermsUpdateInput,
  ctx: UserContext,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== undefined) out[key] = value;
  };
  put("funded_on", input.fundedOn);
  put("funder_name", input.funderName);
  put("amount_cents", input.amount);
  put("factor_rate", input.factorRate);
  put("payment_cents", input.payment);
  put("frequency", input.frequency);
  put("position_no", input.positionNo);
  put("term_days", input.termDays);
  put("commission_cents", input.commission);
  put("paid_back_override_cents", input.paidBackOverride);
  put("last_payment_on", input.lastPaymentOn);
  if (input.promiseToPayAt !== undefined) {
    const at = input.promiseToPayAt
      ? await localToInstant(q, input.promiseToPayAt, ctx.timezone)
      : null;
    out.promise_to_pay_at = at ? at.toISOString() : null;
  }
  put("promise_amount_cents", input.promiseAmount);
  put("note", input.note);
  put("commission_received_cents", input.commissionReceived);
  put("commission_received_on", input.commissionReceivedOn);
  return out;
}

/** Edits an advance in one transaction: the row, the renewal call and the timeline (see update_funding_terms). */
export async function updateFundingTerms(
  q: Db,
  input: TermsUpdateInput,
  ctx: UserContext,
): Promise<void> {
  const json = await termsJson(q, input, ctx);
  await q.query("select id from update_funding_terms($1, $2::jsonb)", [
    input.fundingId,
    JSON.stringify(json),
  ]);
}

export async function recordCommissionReceived(
  q: Db,
  input: CommissionReceivedInput,
): Promise<void> {
  await q.query("select id from update_funding_terms($1, $2::jsonb)", [
    input.fundingId,
    JSON.stringify({
      commission_received_cents: input.amount,
      commission_received_on: input.receivedOn,
    }),
  ]);
}
