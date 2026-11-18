import { z } from "zod";
import { parseMoney } from "../money";

/** What the approval forms may send. Kept out of the "use server" file so a test can parse them. */

const uuid = z.string().uuid("That record no longer exists");
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date")
  // a real calendar date (2026-02-31 rolls over to March 2 in Date), in a sane range
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return (
      !Number.isNaN(d.getTime()) &&
      d.toISOString().slice(0, 10) === s &&
      s >= "2000-01-01" &&
      s <= "2100-12-31"
    );
  }, "Pick a date");

/** A new approval's hold cannot already be over (a mistyped year would stop the emails at once). A day of slack covers every time zone. */
const notPast = isoDate.refine(
  (s) => s >= new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
  "That hold date has already passed",
);

/** "$85,000", "85k", 85000 → cents. */
const amount = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const cents = parseMoney(v);
  if (cents === null || cents <= 0) {
    ctx.addIssue({ code: "custom", message: "Enter the approved amount, like 85,000" });
    return z.NEVER;
  }
  if (cents > 100_000_000_000) {
    ctx.addIssue({ code: "custom", message: "That amount is too large" });
    return z.NEVER;
  }
  return cents;
});

export const approvalSchema = z.object({
  clientId: uuid,
  amount,
  holdUntil: notPast.nullable().default(null),
  funder: z.string().trim().max(120).default(""),
  note: z.string().trim().max(2000).default(""),
  /** Start the emails now (the default) or hold them until a rep presses Start. */
  startEmails: z.boolean().default(true),
});
export type ApprovalInput = z.infer<typeof approvalSchema>;

export const approvalEditSchema = z.object({
  approvalId: uuid,
  amount,
  holdUntil: isoDate.nullable().default(null),
  funder: z.string().trim().max(120).default(""),
  note: z.string().trim().max(2000).default(""),
});
export type ApprovalEditInput = z.infer<typeof approvalEditSchema>;

export const approvalIdSchema = z.object({ approvalId: uuid });

export const closeSchema = z.object({
  approvalId: uuid,
  reason: z.string().trim().max(300).default(""),
});

export const designSchema = z.object({
  step: z.coerce.number().int().min(1).max(6),
  subject: z.string().trim().max(200),
  html: z.string().max(400_000),
  fileName: z.string().trim().max(200).default(""),
});
export type DesignInput = z.infer<typeof designSchema>;

export const delaySchema = z.object({
  step: z.coerce.number().int().min(2).max(6),
  /** 1 hour to 90 days. */
  hours: z.coerce.number().int().min(1, "At least an hour").max(2160, "At most 90 days"),
});

export const approvalSettingsSchema = z
  .object({
    on: z.boolean(),
    windowStart: z.coerce.number().int().min(0).max(23),
    windowEnd: z.coerce.number().int().min(1).max(24),
    weekends: z.boolean(),
  })
  .refine((v) => v.windowStart < v.windowEnd, {
    message: "The day has to start before it ends",
    path: ["windowEnd"],
  });
export type ApprovalSettingsInput = z.infer<typeof approvalSettingsSchema>;

export const phoneSchema = z.object({
  phone: z
    .string()
    .trim()
    .max(40)
    .refine((p) => p === "" || p.replace(/\D/g, "").length >= 10, "Enter a full phone number"),
});
