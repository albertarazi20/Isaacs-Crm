import { z } from "zod";

/*
 * What the settings forms may send. They live here, not in the "use server" file, so a test can parse them and the
 * action stays a thin wrapper. A field the form does not send keeps its stored value (the optional ones), so an
 * older form can never reset a setting it does not know about.
 */

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
  /** The "opened but did not finish" nudge (0548). Not sent = the stored value stays. */
  openNudge: z.boolean().optional(),
});
export type ShopSettingsInput = z.infer<typeof shopSchema>;

export const aiSchema = z.object({
  aiEnabled: z.boolean(),
  aiModel: z.string().trim().min(3).max(60),
  aiDailyCapCents: z.coerce.number().int().min(0).max(100_000),
  /** The background preparation of each rep's next steps (0554). */
  brainOn: z.boolean(),
  brainDailyPerRep: z.coerce.number().int().min(1).max(100),
  /** The shop's house rules, read by the assistant in every conversation. */
  playbook: z.string().max(4000),
});
export type AiSettingsInput = z.infer<typeof aiSchema>;
