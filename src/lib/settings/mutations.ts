import type { Db } from "../db";
import type { AiSettingsInput, ShopSettingsInput } from "./schemas";

/** The one shop_settings row. A field the form left out (undefined) keeps what is stored. */
export async function saveShopSettings(q: Db, i: ShopSettingsInput): Promise<void> {
  await q.query(
    `update shop_settings set shop_name = $1, postal_address = $2, daily_cap = $3, amber_at = $4, reserved_for_intake = $5,
            sequences_enabled = $6, send_window_start = $7, send_window_end = $8, send_on_weekends = $9,
            per_merchant_daily = $10, per_merchant_weekly = $11, automation_from = $12, automation_reply_to_rep = $13,
            send_on_holidays = coalesce($14::boolean, send_on_holidays),
            open_nudge_since = case when coalesce($15::boolean, open_nudge) and not open_nudge then now()
                                    else open_nudge_since end,
            open_nudge = coalesce($15::boolean, open_nudge)`,
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
      i.sendOnHolidays ?? null,
      i.openNudge ?? null,
    ],
  );
}

export async function saveAiSettings(q: Db, i: AiSettingsInput): Promise<void> {
  await q.query(
    "update shop_settings set ai_enabled = $1, ai_model = $2, ai_daily_cap_cents = $3",
    [i.aiEnabled, i.aiModel, i.aiDailyCapCents],
  );
}
