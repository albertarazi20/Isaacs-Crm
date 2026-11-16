import type { Db } from "../db";
import { UserError } from "../data/mutations";
import type {
  AiSettingsInput,
  RegistrationInput,
  RetentionInput,
  ShopSettingsInput,
} from "./schemas";

/** The one shop_settings row. A field the form left out (undefined) keeps what is stored. */
export async function saveShopSettings(q: Db, i: ShopSettingsInput): Promise<void> {
  await q.query(
    `update shop_settings set shop_name = $1, postal_address = $2, daily_cap = $3, amber_at = $4, reserved_for_intake = $5,
            sequences_enabled = $6, send_window_start = $7, send_window_end = $8, send_on_weekends = $9,
            per_merchant_daily = $10, per_merchant_weekly = $11, automation_from = $12, automation_reply_to_rep = $13,
            lender_chase_days = $14, lender_chase_mode = $15, lender_chase_max = $16, max_lenders_per_deal = $17,
            send_on_holidays = coalesce($18::boolean, send_on_holidays),
            approval_valid_days = coalesce($19::int, approval_valid_days),
            resubmit_block_days = coalesce($20::int, resubmit_block_days),
            deals_inbox_address = coalesce($21::text, deals_inbox_address)`,
    [
      i.shopName,
      i.postalAddress,
      i.dailyCap,
      i.amberAt,
      i.reservedForIntake,
      i.sequencesEnabled,
      i.sendWindowStart,
      i.sendWindowEnd,
      i.sendOnWeekends,
      i.perMerchantDaily,
      i.perMerchantWeekly,
      i.automationFrom,
      i.automationReplyToRep,
      i.lenderChaseDays,
      i.lenderChaseMode,
      i.lenderChaseMax,
      i.maxLendersPerDeal,
      i.sendOnHolidays ?? null,
      i.approvalValidDays ?? null,
      i.resubmitBlockDays ?? null,
      i.dealsInboxAddress ?? null,
    ],
  );
}

export async function saveAiSettings(q: Db, i: AiSettingsInput): Promise<void> {
  await q.query(
    `update shop_settings set ai_enabled = $1, ai_model = $2, ai_daily_cap_cents = $3, ai_auto_apply_low_stakes = $4,
            winback_opener_mode = coalesce($5::text, winback_opener_mode)`,
    [
      i.aiEnabled,
      i.aiModel,
      i.aiDailyCapCents,
      i.aiAutoApplyLowStakes,
      i.winbackOpenerMode ?? null,
    ],
  );
}

export async function saveDocumentRetention(q: Db, i: RetentionInput): Promise<void> {
  await q.query("update shop_settings set document_retention_days = $1", [i.days]);
}

/**
 * One registration row per state, added or changed. The state must have a rules row (the lawyer keeps that table);
 * a refusal says so in plain words rather than surfacing the foreign key.
 */
export async function saveRegistration(q: Db, i: RegistrationInput): Promise<void> {
  const known = await q.query("select 1 from state_rules where state = $1", [i.state]);
  if (known.rowCount === 0)
    throw new UserError(
      `There are no rules on file for ${i.state}. The shop's lawyer adds a state to the rules first.`,
    );
  const r = await q.query(
    `insert into shop_registrations (state, registration_no, status, renews_on, note)
     values ($1, $2, $3, $4::date, $5)
     on conflict (state) do update
       set registration_no = excluded.registration_no, status = excluded.status,
           renews_on = excluded.renews_on, note = excluded.note`,
    [i.state, i.registrationNo, i.status, i.renewsOn, i.note],
  );
  // RLS: only a manager may write; a refused write is a silent zero rows, so say it.
  if (r.rowCount === 0) throw new UserError("Only a manager can change the registrations");
}
