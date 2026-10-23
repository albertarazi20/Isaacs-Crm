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

/** The JSON update_funding_terms() takes, from a validated form. Exported so a test can pin the exact keys. */
export async function termsJson(
  q: Db,
  input: TermsUpdateInput,
  ctx: UserContext,
): Promise<Record<string, unknown>> {
  const promiseAt = input.promiseToPayAt
    ? await localToInstant(q, input.promiseToPayAt, ctx.timezone)
    : null;
  return {
    funded_on: input.fundedOn,
    funder_name: input.funderName,
    amount_cents: input.amount,
    factor_rate: input.factorRate,
    payment_cents: input.payment,
    frequency: input.frequency,
    position_no: input.positionNo,
    term_days: input.termDays,
    commission_cents: input.commission,
    paid_back_override_cents: input.paidBackOverride,
    last_payment_on: input.lastPaymentOn ?? null,
    promise_to_pay_at: promiseAt ? promiseAt.toISOString() : null,
    promise_amount_cents: input.promiseAmount,
    note: input.note,
    commission_received_cents: input.commissionReceived,
    commission_received_on: input.commissionReceivedOn ?? null,
  };
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
