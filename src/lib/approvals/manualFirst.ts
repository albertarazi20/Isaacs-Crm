import { z } from "zod";
import { UserError } from "../data/mutations";
import { approvalSchema } from "./schemas";

/**
 * "I sent the first email myself". The rep sends the first approval email from their own mailbox and tells the CRM
 * when; the CRM records step 1 as sent at that moment (approvals.first_sent_at, migration 0580) without putting
 * anything on the outbox, and the engine schedules follow-up 1 its delay (Settings) after it. The input lives here, not
 * in schemas.ts: it extends the approval form's own schema.
 */

const instant = z.string().datetime({ offset: true, message: "Pick a date and time" });

/** Mark an approval: the form's fields, plus how the first email goes. */
export const approvalWithFirstSchema = approvalSchema.extend({
  /** "mine": the rep already sent it. "later": they will send it, and record it when they have (the default). */
  firstEmail: z.enum(["mine", "later"]).default("later"),
  /** When the rep sent it (an ISO instant); empty means now. Only read when firstEmail is "mine". */
  sentAt: instant.nullable().default(null),
});
export type ApprovalWithFirstInput = z.infer<typeof approvalWithFirstSchema>;

/** For an approval created with the emails held: "I already sent the first email". */
export const recordFirstSchema = z.object({
  approvalId: z.string().uuid("That record no longer exists"),
  sentAt: instant.nullable().default(null),
});

/** How far back a hand-sent first email can be dated, and how far ahead (clock slack) it can be. */
export const FIRST_SENT_MAX_AGE_DAYS = 30;
const SLACK_MS = 5 * 60_000;

/** The moment the rep says they sent it: empty is now. Refuses the future and anything older than 30 days. */
export function checkSentAt(sentAt: Date | null, now: Date): Date {
  const at = sentAt ?? now;
  if (Number.isNaN(at.getTime())) throw new UserError("Pick a date and time");
  if (at.getTime() > now.getTime() + SLACK_MS)
    throw new UserError("That time is still ahead. Pick the time you sent it");
  if (at.getTime() < now.getTime() - FIRST_SENT_MAX_AGE_DAYS * 86_400_000)
    throw new UserError(`Pick a time in the last ${FIRST_SENT_MAX_AGE_DAYS} days`);
  // never later than now: a fraction of a minute of slack must not push the follow-up out
  return at.getTime() > now.getTime() ? now : at;
}

/** The form value (an ISO instant or empty) as a Date for the mutation. */
export const parseSentAt = (s: string | null): Date | null => (s ? new Date(s) : null);
