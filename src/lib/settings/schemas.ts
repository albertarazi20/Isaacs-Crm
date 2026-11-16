import { z } from "zod";

/*
 * What the settings forms may send. They live here, not in the "use server" file, so a test can parse them and the
 * action stays a thin wrapper. A field the form does not send keeps its stored value (the optional ones), so an
 * older form can never reset a setting it does not know about.
 */

const day = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date, not just the right shape (2026-02-31 is refused here, not by the database). */
export const isRealDate = (s: string): boolean => {
  if (!day.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const shopSchema = z.object({
  shopName: z.string().trim().min(1).max(80),
  postalAddress: z.string().trim().max(300).default(""),
  dailyCap: z.coerce.number().int().min(50).max(2000),
  amberAt: z.coerce.number().int().min(10).max(2000),
  reservedForIntake: z.coerce.number().int().min(0).max(500),
  sequencesEnabled: z.boolean(),
  sendWindowStart: z.coerce.number().int().min(0).max(23),
  sendWindowEnd: z.coerce.number().int().min(1).max(24),
  sendOnWeekends: z.boolean(),
  /** US federal holidays (S1-11). Not sent = the stored value stays. */
  sendOnHolidays: z.boolean().optional(),
  perMerchantDaily: z.coerce.number().int().min(1).max(5),
  perMerchantWeekly: z.coerce.number().int().min(1).max(20),
  automationFrom: z.string().trim().max(200).default(""),
  automationReplyToRep: z.boolean(),
  lenderChaseDays: z.coerce.number().int().min(1).max(14),
  /** off: never; draft: write the chase into the rep's drafts; send: from the rep's Gmail. */
  lenderChaseMode: z.enum(["send", "draft", "off"]),
  lenderChaseMax: z.coerce.number().int().min(0).max(5),
  maxLendersPerDeal: z.coerce.number().int().min(1).max(30),
  /** How long an approval stands when the lender names no days of its own (S2). */
  approvalValidDays: z.preprocess(
    blankToUndefined,
    z.coerce
      .number("Approval validity must be a whole number of days")
      .int()
      .min(1, "Approval validity is at least 1 day")
      .max(365, "Approval validity is at most 365 days")
      .optional(),
  ),
  /** Sending the same merchant to the same lender inside this window needs a deliberate "send anyway". 0 = no guard. */
  resubmitBlockDays: z.preprocess(
    blankToUndefined,
    z.coerce
      .number("The double-submission window must be a whole number of days")
      .int()
      .min(0, "The double-submission window can't be negative")
      .max(365, "The double-submission window is at most 365 days")
      .optional(),
  ),
  /** Where lenders reply to a file sent from the CRM; empty = replies go to the rep. */
  dealsInboxAddress: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .refine((v) => v === "" || /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/.test(v), {
      message: "The deals inbox must be one email address, like deals@yourshop.com",
    })
    .optional(),
});
export type ShopSettingsInput = z.infer<typeof shopSchema>;

export const aiSchema = z.object({
  aiEnabled: z.boolean(),
  aiModel: z.string().trim().min(3).max(60),
  aiDailyCapCents: z.coerce.number().int().min(0).max(100_000),
  aiAutoApplyLowStakes: z.boolean(),
  /** The win-back first line: merged as drafted (auto) or held for a manager's OK (review). Not sent = unchanged. */
  winbackOpenerMode: z.enum(["auto", "review"]).optional(),
});
export type AiSettingsInput = z.infer<typeof aiSchema>;

export const retentionSchema = z.object({
  days: z.coerce
    .number("Retention must be a whole number of days")
    .int()
    .min(30, "Keep documents at least 30 days")
    .max(3650, "Ten years (3650 days) is the longest"),
});
export type RetentionInput = z.infer<typeof retentionSchema>;

export const REGISTRATION_STATUSES = ["none", "filed", "registered", "exempt"] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const registrationSchema = z.object({
  state: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Pick a state"),
  status: z.enum(REGISTRATION_STATUSES),
  registrationNo: z.string().trim().max(60).default(""),
  /** The renewal date; empty = none on file. */
  renewsOn: z.preprocess(
    blankToUndefined,
    z
      .string()
      .refine(isRealDate, { message: "The renewal date must be a real date" })
      .nullish()
      .transform((v) => v ?? null),
  ),
  note: z.string().trim().max(300).default(""),
});
export type RegistrationInput = z.infer<typeof registrationSchema>;
