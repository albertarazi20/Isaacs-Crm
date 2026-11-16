import type { DbAccess } from "../db";
import { todayIn } from "../mca/dates";
import { buildNewLeadAlert } from "../mca/digest";
import { formatMoneyCompact } from "../money";
import type { DigestSender } from "./reminders";

/** A flood of leads (or an abused token) can't turn into a flood of email: this many alerts a day, then silence. */
export const NEW_LEAD_ALERTS_PER_DAY = 20;

export type LeadAlertResult = "sent" | "skipped" | "capped";

/**
 * Emails the owner that a lead just arrived. Claim-then-send, like the digest: the claim row (one per lead)
 * is written first, so a retry or a duplicate call can't send twice, and rolled back if the send fails.
 * Never throws to the caller's request path — the lead is already saved; a failed alert must not undo it.
 */
export async function sendNewLeadAlert(args: {
  db: DbAccess;
  userId: string;
  clientId: string;
  now: Date;
  appUrl: string;
  send: DigestSender;
  cap?: number;
}): Promise<LeadAlertResult> {
  return args.db.withSystem(async (q) => {
    const { rows } = await q.query<{
      timezone: string;
      to_email: string;
      digest_enabled: boolean;
      active: boolean;
      business_name: string;
      contact_name: string;
      phone: string;
      source: string;
      wanted_amount_cents: number | null;
    }>(
      `select u.timezone, coalesce(u.notify_email, u.email) as to_email, u.digest_enabled, u.active,
              c.business_name, c.contact_name, c.phone, c.source,
              (select k.wanted_amount_cents from client_asks k where k.client_id = c.id
                order by k.created_at desc limit 1) as wanted_amount_cents
         from clients c join app_users u on u.id = c.user_id
        where c.id = $1 and c.user_id = $2
          and not exists (select 1 from trashed_clients t where t.client_id = c.id)`,
      [args.clientId, args.userId],
    );
    const lead = rows[0];
    // The reminder switch in Settings is also the switch for this email.
    if (!lead || !lead.digest_enabled || !lead.active) return "skipped";

    const day = todayIn(lead.timezone, args.now);
    const { rows: used } = await q.query<{ n: number }>(
      "select count(*)::int as n from reminders_sent where user_id = $1 and kind = 'new_lead' and for_date = $2",
      [args.userId, day],
    );
    if ((used[0]?.n ?? 0) >= (args.cap ?? NEW_LEAD_ALERTS_PER_DAY)) return "capped";

    const claim = await q.query(
      "insert into reminders_sent (user_id, kind, for_date, ref) values ($1, 'new_lead', $2, $3) on conflict do nothing",
      [args.userId, day, args.clientId],
    );
    if (claim.rowCount === 0) return "skipped";

    const msg = buildNewLeadAlert(
      {
        clientId: args.clientId,
        businessName: lead.business_name,
        contactName: lead.contact_name,
        phone: lead.phone,
        wantedAmount: lead.wanted_amount_cents
          ? formatMoneyCompact(lead.wanted_amount_cents)
          : null,
        source: lead.source,
      },
      args.appUrl,
    );
    const providerId = await args.send(lead.to_email, msg);
    await q.query(
      "update reminders_sent set provider_id = $4 where user_id = $1 and kind = 'new_lead' and for_date = $2 and ref = $3",
      [args.userId, day, args.clientId, providerId],
    );
    return "sent";
  });
}
