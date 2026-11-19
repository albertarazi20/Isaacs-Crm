import { z } from "zod";
import { automationDomain } from "../send/dns";

/*
 * What the settings forms may send. They live here, not in the "use server" file, so a test can parse them and the
 * action stays a thin wrapper. A field the form does not send keeps its stored value (the optional ones), so an
 * older form can never reset a setting it does not know about.
 */

/** The daily reminder runs from 6:00 AM (360) to 8:00 PM (1200), minutes after local midnight; the database checks the same. */
export const DAILY_REMINDER_MIN = 360;
export const DAILY_REMINDER_MAX = 1200;
const DAILY_REMINDER_MESSAGE = "Daily reminder time must be between 6:00 AM and 8:00 PM.";

const shopFields = z.object({
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
  /** Empty, or "name@domain" / "Name <name@domain>": a value with no usable domain could never pass the DNS gate. */
  automationFrom: z
    .string()
    .trim()
    .max(200)
    .regex(/^[^\p{Cc}]*$/u, "The sender can't contain line breaks or control characters")
    .refine((v) => v === "" || automationDomain(v) !== null, {
      message: 'Use an address like "Selective <hello@mail.example.com>", or leave it empty.',
    })
    .default(""),
  automationReplyToRep: z.boolean(),
  /** The "opened but did not finish" nudge (0548). Not sent = the stored value stays. */
  openNudge: z.boolean().optional(),
  /** When a daily-reminder bucket sends, in minutes after the merchant's local midnight (0593). Not sent = the stored value stays. */
  dailyReminderMinute: z
    .number({ error: DAILY_REMINDER_MESSAGE })
    .int(DAILY_REMINDER_MESSAGE)
    .min(DAILY_REMINDER_MIN, DAILY_REMINDER_MESSAGE)
    .max(DAILY_REMINDER_MAX, DAILY_REMINDER_MESSAGE)
    .optional(),
});
/*
 * Each number is valid alone, but some pairs silence the worker without a word: a send window that is empty (start at or
 * after the end) never opens, and a reserved slice as big as the daily cap leaves no room for sequences or blasts
 * (capAllows holds them forever). Those are refused here, with the reason, rather than saved.
 */
export const shopSchema = shopFields.superRefine((v, ctx) => {
  const bad = (path: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [path], message });
  if (v.sendWindowStart >= v.sendWindowEnd)
    bad(
      "sendWindowEnd",
      "The send window must end after it starts, or no email would ever go out.",
    );
  if (v.reservedForIntake >= v.dailyCap)
    bad(
      "reservedForIntake",
      "The slice kept for intake must be smaller than the daily cap, or no sequence email would ever go out.",
    );
  if (v.amberAt > v.dailyCap) bad("amberAt", "The amber warning can't be above the daily cap.");
  if (v.perMerchantDaily > v.perMerchantWeekly)
    bad("perMerchantWeekly", "The weekly limit can't be lower than the daily limit.");
});
export type ShopSettingsInput = z.infer<typeof shopSchema>;

/** The models the settings page offers. The server accepts only these, so a stale form or crafted request cannot save a name the API rejects. */
export const AI_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export const DEFAULT_AI_MODEL = "claude-sonnet-5-5";

export const aiSchema = z.object({
  aiEnabled: z.boolean(),
  aiModel: z.enum(AI_MODELS),
  aiDailyCapCents: z.coerce.number().int().min(0).max(100_000),
  /** The background preparation of each rep's next steps (0554). */
  brainOn: z.boolean(),
  brainDailyPerRep: z.coerce.number().int().min(1).max(100),
  /** The shop's house rules, read by the assistant in every conversation. */
  playbook: z.string().max(4000),
});
export type AiSettingsInput = z.infer<typeof aiSchema>;
