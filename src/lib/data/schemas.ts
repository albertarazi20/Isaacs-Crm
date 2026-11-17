import "../zod-setup";
import { z } from "zod";
import { findSensitive } from "./sensitive";
import { isRealDate } from "../mca/dates";
import { STAGE_KEYS } from "../mca/stages";
import { parseMoney } from "../money";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
  .refine(isRealDate, "That isn't a real calendar date");
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Pick a date and time");
export const id = z.string().uuid();
/** Multi-line text (notes, bodies). Refuses SSNs and card/account numbers — see sensitive.ts. */
const tooLong = (max: number) =>
  `That's too long — the limit is ${max.toLocaleString("en-US")} characters`;

export const text = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max, tooLong(max))
    .superRefine((v, ctx) => {
      const hit = findSensitive(v);
      if (hit) ctx.addIssue({ code: "custom", message: hit.message });
    });

/** Single-line field: no line breaks or control characters (they would become email header injection). */
export const line = (max = 200) =>
  z
    .string()
    .trim()
    .max(max, tooLong(max))
    .regex(/^[^\p{Cc}]*$/u, "That field can't contain line breaks or control characters")
    // The same guard as notes: an SSN typed into "Source" or "terms" is as stored as one typed into a note.
    .superRefine((v, ctx) => {
      const hit = findSensitive(v);
      if (hit) ctx.addIssue({ code: "custom", message: hit.message });
    });

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
/** Blank, or exactly one plain address — never "a@b.com,c@d.com". */
const emailField = line(200).refine(
  (v) => v === "" || EMAIL.test(v),
  "Enter one valid email address",
);
export const money = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const cents = parseMoney(v);
  if (cents === null) {
    ctx.addIssue({ code: "custom", message: "Enter an amount like 50k or $75,000" });
    return z.NEVER;
  }
  return cents;
});

/** Blank means "not provided"; junk is refused with a message, never dropped on the floor. */
export const optMoney = z
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
  businessName: line(200).min(1, "Business name is required"),
  contactName: line(200).default(""),
  phone: line(40).default(""),
  email: emailField.default(""),
  industry: line(100).default(""),
  state: line(40).default(""),
  source: line(100).default(""),
  stage: z.enum(STAGE_KEYS).default("name_in"),
  followUpOn: isoDate.optional(),
  wantedAmount: optMoney.optional(),
  monthlyRevenue: optMoney.optional(),
});
export type NewClientInput = z.output<typeof newClientSchema>;

export const moveSchema = z.object({
  clientId: id,
  stage: z.enum(STAGE_KEYS),
  followUpOn: isoDate.optional(),
  reason: text().default(""),
  /** "Phone call scheduled" only: when the call is, as typed (local date and time). */
  callAt: localDateTime.optional(),
});
export type MoveInput = z.output<typeof moveSchema>;

/** keepCalls: leave a booked call on its own date (a drag does; Snooze doesn't). */
export const followUpSchema = z.object({
  clientId: id,
  dueOn: isoDate,
  keepCalls: z.boolean().optional(),
});
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
  channel: z.enum(["call", "text", "email"]).default("call"),
});
export const noteSchema = z.object({
  clientId: id,
  body: text(5000).min(1, "Write something first"),
});

export const clientFieldsSchema = z
  .object({
    businessName: line(200).min(1, "Business name is required"),
    dba: line(200),
    contactName: line(200),
    phone: line(40),
    email: emailField,
    industry: line(100),
    state: line(40),
    source: line(100),
    monthlyRevenue: optMoney,
    timeInBusinessMonths: optInt,
    applicationReceivedOn: isoDate.nullable(),
  })
  .partial();
export const updateClientSchema = z.object({ clientId: id, fields: clientFieldsSchema });
export type ClientFieldsInput = z.output<typeof clientFieldsSchema>;

export const idSchema = z.object({ id });
export const clientIdSchema = z.object({ clientId: id });
/** Two cards for one merchant: everything on `dropId` moves to `keepId`, and `dropId` is deleted. */
export const mergeSchema = z.object({ keepId: id, dropId: id });
export const stipSchema = z.object({ stipId: id, received: z.boolean() });

export const emailSchema = z.object({
  clientId: id,
  subject: line(200).min(1, "Add a subject"),
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
});

export const importRowSchema = z.object({
  line: z.number().int().min(1),
  businessName: line(200).min(1),
  contactName: line(200).default(""),
  phone: line(40).default(""),
  email: emailField.default(""),
  wantedAmount: line(40).default(""),
  industry: line(100).default(""),
  state: line(40).default(""),
  notes: text(5000).default(""),
  stage: z.enum(STAGE_KEYS),
  followUpOn: isoDate,
  source: line(100).default(""),
  statusNote: line(200).default(""),
});
export type ImportRowInput = z.output<typeof importRowSchema>;

export const importSchema = z.object({
  rows: z
    .array(importRowSchema)
    .min(1, "Nothing to import")
    .max(2000, "Import up to 2,000 clients at a time"),
});

export const duplicateCheckSchema = z.object({
  phone: line(40).optional(),
  businessName: line(200).optional(),
  /** Editing a merchant: he is not a duplicate of himself. */
  excludeId: id.optional(),
});

export const contactStatusSchema = z.object({
  clientId: id,
  status: z.enum(["ok", "no_text", "no_call", "no_email", "dnc"]),
  note: text(500).default(""),
});
