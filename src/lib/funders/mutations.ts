import type { Db } from "../db";
import { UserError } from "../data/mutations";
import type { FunderInput, OfferInput, SendInput, StatusInput } from "./schemas";
import type { OfferStatus } from "./types";

/** Insert or update a funder. A duplicate name (any capitalisation) is a plain-words refusal, not a database error. */
export async function saveFunder(q: Db, input: FunderInput): Promise<string> {
  const values = [
    input.name,
    input.submissionEmail,
    input.contactName,
    input.phone,
    input.notes,
    input.minMonthlyRevenue,
    input.minTimeInBusinessMonths,
    input.maxPosition,
    input.minAmount,
    input.maxAmount,
    input.excludedStates,
    input.excludedIndustries,
    input.commissionPoints,
    input.renewalPaydownPct,
  ];
  try {
    if (input.id) {
      const res = await q.query<{ id: string }>(
        `update funders set name = $2, submission_email = $3, contact_name = $4, phone = $5, notes = $6,
                min_monthly_revenue_cents = $7, min_time_in_business_months = $8, max_position = $9,
                min_amount_cents = $10, max_amount_cents = $11, excluded_states = $12,
                excluded_industries = $13, commission_points = $14, renewal_paydown_pct = $15
          where id = $1 returning id`,
        [input.id, ...values],
      );
      if (!res.rows[0]) throw new UserError("That funder no longer exists");
      return res.rows[0].id;
    }
    const res = await q.query<{ id: string }>(
      `insert into funders (user_id, name, submission_email, contact_name, phone, notes,
              min_monthly_revenue_cents, min_time_in_business_months, max_position,
              min_amount_cents, max_amount_cents, excluded_states, excluded_industries,
              commission_points, renewal_paydown_pct)
       values (app.current_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       returning id`,
      values,
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error("insert returned no row");
    return id;
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "23505")
      throw new UserError(`You already have a funder called ${input.name}`);
    throw e;
  }
}

export async function setFunderActive(q: Db, id: string, active: boolean): Promise<void> {
  const res = await q.query("update funders set active = $2 where id = $1", [id, active]);
  if (res.rowCount === 0) throw new UserError("That funder no longer exists");
}

/**
 * Only a funder nothing was ever sent to can be deleted; otherwise archive it and the history stays.
 * The database refuses too (submissions' funder reference), but it only says so at commit, so ask first.
 */
export async function deleteFunder(q: Db, id: string): Promise<void> {
  const used = await q.query("select 1 from submissions where funder_id = $1 limit 1", [id]);
  if (used.rowCount)
    throw new UserError("Applications were sent to this funder — archive it instead");
  const res = await q.query("delete from funders where id = $1", [id]);
  if (res.rowCount === 0) throw new UserError("That funder no longer exists");
}

export async function sendToFunders(q: Db, input: SendInput): Promise<number> {
  const res = await q.query("select id from create_submissions($1, $2::uuid[], $3::date, $4)", [
    input.clientId,
    input.funderIds,
    input.sentOn ?? null,
    input.note,
  ]);
  return res.rowCount ?? 0;
}

export async function setSubmissionStatus(q: Db, input: StatusInput): Promise<void> {
  await q.query("select id from set_submission_status($1, $2, $3, $4)", [
    input.submissionId,
    input.status,
    input.declineReason ?? null,
    input.note,
  ]);
}

export async function recordOffer(q: Db, input: OfferInput): Promise<string> {
  const res = await q.query<{ id: string }>("select id from record_offer($1, $2::jsonb)", [
    input.submissionId,
    JSON.stringify({
      amount_cents: input.amount,
      factor_rate: input.factorRate,
      payment_cents: input.payment,
      frequency: input.frequency ?? null,
      term_days: input.termDays,
      position_no: input.positionNo,
      fees_cents: input.fees,
      note: input.note,
      received_on: input.receivedOn ?? null,
    }),
  ]);
  const id = res.rows[0]?.id;
  if (!id) throw new Error("record_offer returned no row");
  return id;
}

export async function acceptOffer(q: Db, offerId: string): Promise<void> {
  await q.query("select id from accept_offer($1)", [offerId]);
}

export async function setOfferStatus(q: Db, offerId: string, status: OfferStatus): Promise<void> {
  await q.query("select id from set_offer_status($1, $2)", [offerId, status]);
}

export async function removeSubmission(q: Db, submissionId: string): Promise<void> {
  await q.query("select remove_submission($1)", [submissionId]);
}

/** An offer typed wrong: remove it and enter it again. (A funder's yes stays a yes.) */
export async function removeOffer(q: Db, offerId: string): Promise<void> {
  const res = await q.query("delete from offers where id = $1", [offerId]);
  if (res.rowCount === 0) throw new UserError("That offer no longer exists");
}
