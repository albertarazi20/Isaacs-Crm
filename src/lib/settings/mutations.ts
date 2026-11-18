import { UserError } from "../data/mutations";
import type { Db } from "../db";
import { automationDomain } from "../send/dns";
import type { AiSettingsInput, ShopSettingsInput } from "./schemas";

/** The one shop_settings row. A field the form left out (undefined) keeps what is stored. */
export async function saveShopSettings(q: Db, i: ShopSettingsInput): Promise<void> {
  // A trigger clears the DNS result whenever automation_from changes. Only a different domain should: a new display
  // name or mailbox on the same domain keeps its passing SPF/DKIM/DMARC check, so automation does not halt.
  const before = (
    await q.query<{
      automation_from: string;
      dns_ok: boolean;
      dns_checked_at: string | null;
      dns_result: unknown;
    }>("select automation_from, dns_ok, dns_checked_at, dns_result from shop_settings")
  ).rows[0];
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
  const sameDomain =
    before !== undefined &&
    before.automation_from !== i.automationFrom &&
    automationDomain(before.automation_from) !== null &&
    automationDomain(before.automation_from) === automationDomain(i.automationFrom);
  if (before && sameDomain) {
    await q.query(
      "update shop_settings set dns_ok = $1, dns_checked_at = $2, dns_result = $3::jsonb",
      [before.dns_ok, before.dns_checked_at, JSON.stringify(before.dns_result)],
    );
  }
}

export async function saveAiSettings(q: Db, i: AiSettingsInput): Promise<void> {
  await q.query(
    `update shop_settings set ai_enabled = $1, ai_model = $2, ai_daily_cap_cents = $3,
                              brain_on = $4, brain_daily_per_rep = $5, playbook = $6`,
    [i.aiEnabled, i.aiModel, i.aiDailyCapCents, i.brainOn, i.brainDailyPerRep, i.playbook.trim()],
  );
}

/** Reasons where the merchant (or their mail provider) told us not to contact them: never reversible by hand. */
const REFUSED_REMOVAL: Record<string, string> = {
  complaint:
    "This address reported our email as spam, so it stays on the list. It can't be removed by hand.",
  unsubscribe:
    "This merchant unsubscribed, so they stay on the list. Only they can opt back in, by asking us to email them again.",
  stop_reply:
    "This merchant replied to stop, so they stay on the list. Only they can opt back in, by asking us to contact them again.",
  dnc: "This merchant is on the do-not-contact list, so they stay on it. It can't be removed by hand.",
};

/**
 * Take one address off the do-not-email list. Deleting the row alone left clients.email_opt_out set, so the engine
 * still refused every email as "opted_out": for a manual suppression (a rep put the address there by hand) the
 * opt-out flag is cleared in the same transaction. Where the merchant themselves asked not to be contacted
 * (unsubscribe, stop reply, do not contact) or their mail provider reported spam (complaint), nothing is removed:
 * one click must not re-enable automated mail to someone who opted out. A hard bounce is only a dead address, so
 * its row can go (the flag is left as it is). A row a "Stop emails for good" wrote is a manual one: removing it turns
 * the merchant's emails back on (resume_merchant_emails, 0580), and nothing restarts by itself.
 */
export async function removeSuppression(q: Db, suppressionId: string): Promise<void> {
  const row = (
    await q.query<{ channel: string; reason: string; client_id: string | null }>(
      "select channel, reason, client_id from suppressions where id = $1",
      [suppressionId],
    )
  ).rows[0];
  if (!row) return;
  const refusal = REFUSED_REMOVAL[row.reason];
  if (refusal !== undefined) throw new UserError(refusal);
  await q.query("delete from suppressions where id = $1", [suppressionId]);
  if (row.channel === "email" && row.client_id !== null && row.reason === "manual") {
    await q.query("update clients set email_opt_out = false where id = $1", [row.client_id]);
    // a "Stop emails for good" (0580) also clears its own marks: the badge, the approval's stop note, and a timeline
    // line. Nothing restarts: the approval waits for someone to press "Start the emails". Refused (and the whole
    // removal undone) if the merchant also unsubscribed.
    await q.query("select public.resume_merchant_emails($1)", [row.client_id]);
  }
}
