import { z } from "zod";
import { STAGE_KEYS } from "../mca/stages";
import { parseFactor, parseMoney } from "../money";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Pick a date and time");
const id = z.string().uuid();
const text = (max = 2000) => z.string().trim().max(max);
const frequency = z.enum(["daily", "weekly", "biweekly", "monthly"]);

const money = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const cents = parseMoney(v);
  if (cents === null) {
    ctx.addIssue({ code: "custom", message: "Enter an amount like 50k or $75,000" });
    return z.NEVER;
  }
  return cents;
});

/** Blank means "not provided". */
const optMoney = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v, ctx): number | null => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    const cents = parseMoney(v);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: "Enter an amount like 50k or $75,000" });
      return z.NEVER;
    }
    return cents;
  });

const factor = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const f = parseFactor(v);
  if (f === null) {
    ctx.addIssue({ code: "custom", message: "Factor rate must be between 1.00 and 3.00" });
    return z.NEVER;
  }
  return f;
});
const optFactor = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v, ctx): number | null => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    const f = parseFactor(v);
    if (f === null) {
      ctx.addIssue({ code: "custom", message: "Factor rate must be between 1.00 and 3.00" });
      return z.NEVER;
    }
    return f;
  });
const optInt = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v, ctx): number | null => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) {
      ctx.addIssue({ code: "custom", message: "Enter a whole number" });
      return z.NEVER;
    }
    return n;
  });

export const newClientSchema = z.object({
  businessName: text(200).min(1, "Business name is required"),
  contactName: text(200).default(""),
  phone: text(40).default(""),
  email: text(200).default(""),
  industry: text(100).default(""),
  state: text(40).default(""),
  source: text(100).default(""),
  stage: z
    .enum(STAGE_KEYS)
    .refine((s) => s !== "funded", "Add the client first, then record the funding")
    .default("name_in"),
  followUpOn: isoDate.optional(),
  wantedAmount: optMoney.optional(),
  monthlyRevenue: optMoney.optional(),
});
export type NewClientInput = z.output<typeof newClientSchema>;

export const fundingInputSchema = z.object({
  fundedOn: isoDate.optional(),
  amount: money,
  factorRate: factor,
  payment: money,
  frequency,
  funderName: text(200).default(""),
  positionNo: optInt.optional(),
  termDays: optInt.optional(),
  commission: optMoney.optional(),
});

export const competitorInputSchema = z.object({
  funderName: text(200).min(1, "Who was the competitor?"),
  amount: optMoney.optional(),
  factorRate: optFactor.optional(),
  payment: optMoney.optional(),
  frequency: frequency.optional(),
  positionNo: optInt.optional(),
  termDays: optInt.optional(),
  offeredOn: isoDate.optional(),
  won: z.boolean().default(false),
  note: text().default(""),
});

export const defaultInputSchema = z.object({
  defaultedOn: isoDate.optional(),
  promiseToPayAt: localDateTime.optional(),
  promiseAmount: optMoney.optional(),
  note: text().default(""),
});

export const moveSchema = z
  .object({
    clientId: id,
    stage: z.enum(STAGE_KEYS),
    followUpOn: isoDate.optional(),
    reason: text().default(""),
    funding: fundingInputSchema.optional(),
    competitor: competitorInputSchema.optional(),
    default: defaultInputSchema.optional(),
  })
  .refine((v) => v.stage !== "funded" || v.funding, {
    message: "Funding terms are required to mark a client funded",
    path: ["funding"],
  });
export type MoveInput = z.output<typeof moveSchema>;

export const followUpSchema = z.object({ clientId: id, dueOn: isoDate });
export const bucketSchema = z.object({
  clientId: id,
  bucket: z.enum(["today", "1w", "2w", "1m", "2m", "3m", "6m", "9m", "12m", "18m", "24m", "36m"]),
});

export const touchSchema = z.object({
  clientId: id,
  kind: z.enum(["call", "text", "email"]),
  outcome: z.enum(["reached", "no_answer", "left_message", "bad_number"]).nullable().optional(),
  body: text().default(""),
  nextDueOn: isoDate.optional(),
});
export type TouchInput = z.output<typeof touchSchema>;

export const scheduleCallSchema = z.object({
  clientId: id,
  at: localDateTime,
  note: text().default(""),
});
export const noteSchema = z.object({
  clientId: id,
  body: text(5000).min(1, "Write something first"),
});

export const clientFieldsSchema = z
  .object({
    businessName: text(200).min(1, "Business name is required"),
    dba: text(200),
    contactName: text(200),
    phone: text(40),
    email: text(200),
    industry: text(100),
    state: text(40),
    source: text(100),
    monthlyRevenue: optMoney,
    timeInBusinessMonths: optInt,
    applicationReceivedOn: isoDate.nullable(),
  })
  .partial();
export const updateClientSchema = z.object({ clientId: id, fields: clientFieldsSchema });
export type ClientFieldsInput = z.output<typeof clientFieldsSchema>;

export const askSchema = z.object({
  clientId: id,
  wantedAmount: optMoney,
  wantedTerms: text().default(""),
  estApproval: optMoney,
  estApprovalNote: text().default(""),
});

export const positionSchema = z.object({
  clientId: id,
  id: id.optional(),
  positionNo: z.coerce.number().int().min(1).max(20),
  funderName: text(200).default(""),
  fundedAmount: optMoney,
  payback: optMoney,
  balance: optMoney,
  payment: optMoney,
  frequency: frequency.nullable().optional(),
  fundedOn: isoDate.nullable().optional(),
  note: text().default(""),
});

export const offerSchema = z.object({
  clientId: id,
  id: id.optional(),
  funderName: text(200).min(1, "Who made the offer?"),
  amount: optMoney,
  factorRate: optFactor,
  payment: optMoney,
  frequency: frequency.nullable().optional(),
  positionNo: optInt,
  termDays: optInt,
  offeredOn: isoDate.optional(),
  won: z.boolean().default(false),
  note: text().default(""),
});

export const idSchema = z.object({ id });
export const clientIdSchema = z.object({ clientId: id });
export const stipSchema = z.object({ stipId: id, received: z.boolean() });

export const fundingUpdateSchema = z.object({
  fundingId: id,
  paidBackOverride: optMoney,
  lastPaymentOn: isoDate.nullable().optional(),
  promiseToPayAt: localDateTime.nullable().optional(),
  promiseAmount: optMoney,
  note: text().optional(),
});

export const emailSchema = z.object({
  clientId: id,
  subject: text(200).min(1, "Add a subject"),
  body: text(10_000).min(1, "Write the email first"),
  nextDueOn: isoDate.optional(),
});

export const settingsSchema = z.object({
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown timezone"),
  digestEnabled: z.boolean(),
  digestHour: z.coerce.number().int().min(0).max(23),
  notifyEmail: z.union([z.literal(""), z.string().email()]),
});

export const importRowSchema = z.object({
  line: z.number().int().min(1),
  businessName: text(200).min(1),
  contactName: text(200).default(""),
  phone: text(40).default(""),
  email: text(200).default(""),
  wantedAmount: text(40).default(""),
  industry: text(100).default(""),
  state: text(40).default(""),
  notes: text(5000).default(""),
  stage: z
    .enum(STAGE_KEYS)
    .refine((s) => s !== "funded", "Funded clients can't be imported without terms"),
  followUpOn: isoDate,
  statusNote: text(200).default(""),
});
export type ImportRowInput = z.output<typeof importRowSchema>;

export const importSchema = z.object({
  rows: z
    .array(importRowSchema)
    .min(1, "Nothing to import")
    .max(2000, "Import up to 2,000 clients at a time"),
});

export const duplicateCheckSchema = z.object({
  phone: text(40).optional(),
  businessName: text(200).optional(),
});
