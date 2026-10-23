import "../zod-setup";
import { z } from "zod";
import { findSensitive } from "../data/sensitive";
import { parseFactor, parseMoney } from "../money";
import { parseStateList, splitList } from "./states";
import { DECLINE_REASONS, OFFER_STATUSES, SUBMISSION_STATUSES } from "./types";

// Same rules as src/lib/data/schemas.ts (not exported there, and that file is not ours to edit):
// single-line fields have no control characters, free text refuses SSNs / card / account numbers.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");
const id = z.string().uuid();

const text = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .superRefine((v, ctx) => {
      const hit = findSensitive(v);
      if (hit) ctx.addIssue({ code: "custom", message: hit.message });
    });

const line = (max = 200) =>
  z
    .string()
    .trim()
    .max(max, `Keep it under ${max} characters`)
    .regex(/^[^\p{Cc}]*$/u, "That field can't contain line breaks or control characters")
    .superRefine((v, ctx) => {
      const hit = findSensitive(v);
      if (hit) ctx.addIssue({ code: "custom", message: hit.message });
    });

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const emailField = line(200).refine(
  (v) => v === "" || EMAIL.test(v),
  "Enter one valid email address",
);

const blank = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Blank means "none / not known". */
const optMoney = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v, ctx): number | null => {
    if (blank(v)) return null;
    const cents = parseMoney(v as string | number);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: "Enter an amount like 50k or $75,000" });
      return z.NEVER;
    }
    return cents;
  });

const money = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const cents = parseMoney(v);
  if (cents === null || cents <= 0) {
    ctx.addIssue({ code: "custom", message: "Enter an amount like 50k or $75,000" });
    return z.NEVER;
  }
  return cents;
});

const factor = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const f = parseFactor(v);
  if (f === null) {
    ctx.addIssue({
      code: "custom",
      message: "Factor rate must be between 1.00 and 3.00, like 1.35",
    });
    return z.NEVER;
  }
  return f;
});

const optInt = (what: string, min: number, max = 1_000_000) =>
  z.union([z.string(), z.number(), z.null(), z.undefined()]).transform((v, ctx): number | null => {
    if (blank(v)) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({
        code: "custom",
        message:
          max === 1_000_000
            ? `${what} must be a whole number, ${min} or more`
            : `${what} must be a whole number from ${min} to ${max}`,
      });
      return z.NEVER;
    }
    return n;
  });

const frequency = z.enum(["daily", "weekly", "biweekly", "monthly"]);

/** "10", "7.5", "10%" → 10, 7.5, 10. Points of the funded amount, so 0 to 100. */
const optPoints = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v, ctx): number | null => {
    if (blank(v)) return null;
    const n = typeof v === "number" ? v : Number(String(v).trim().replace(/%$/, ""));
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      ctx.addIssue({
        code: "custom",
        message: "Commission points must be a number from 0 to 100, like 10",
      });
      return z.NEVER;
    }
    return Math.round(n * 100) / 100;
  });

const stateList = z
  .union([z.string(), z.array(z.string())])
  .default("")
  .transform((v, ctx): string[] => {
    const raw = Array.isArray(v) ? v.join(",") : v;
    const { states, unknown } = parseStateList(raw);
    if (unknown.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `"${unknown[0]}" isn't a state — use two-letter codes like FL, NY`,
      });
      return z.NEVER;
    }
    return states;
  });

const industryList = z
  .union([z.string(), z.array(z.string())])
  .default("")
  .transform((v, ctx): string[] => {
    const items = splitList(Array.isArray(v) ? v.join(",") : v);
    if (items.length > 60 || items.some((i) => i.length > 60)) {
      ctx.addIssue({
        code: "custom",
        message: "List up to 60 industries, each under 60 characters",
      });
      return z.NEVER;
    }
    return items;
  });

export const funderSchema = z
  .object({
    id: id.optional(),
    name: line(200).min(1, "Give the funder a name"),
    submissionEmail: emailField.default(""),
    contactName: line(200).default(""),
    phone: line(40).default(""),
    notes: text().default(""),
    minMonthlyRevenue: optMoney.default(null),
    minTimeInBusinessMonths: optInt("Time in business", 0, 1200).default(null),
    maxPosition: optInt("Position", 1, 20).default(null),
    minAmount: optMoney.default(null),
    maxAmount: optMoney.default(null),
    excludedStates: stateList,
    excludedIndustries: industryList,
    commissionPoints: optPoints.default(null),
    renewalPaydownPct: optInt("Renewal threshold", 1, 100).default(null),
  })
  .refine((v) => v.minAmount === null || v.maxAmount === null || v.minAmount <= v.maxAmount, {
    message: "The smallest advance can't be bigger than the largest",
    path: ["maxAmount"],
  });
export type FunderInput = z.output<typeof funderSchema>;

export const funderIdSchema = z.object({ id });
export const funderActiveSchema = z.object({ id, active: z.boolean() });

export const sendSchema = z.object({
  clientId: id,
  funderIds: z
    .array(id)
    .min(1, "Pick at least one funder")
    .max(50, "Send to 50 funders or fewer at a time"),
  sentOn: isoDate.optional(),
  note: text(500).default(""),
});
export type SendInput = z.output<typeof sendSchema>;

export const statusSchema = z
  .object({
    submissionId: id,
    status: z.enum(SUBMISSION_STATUSES),
    declineReason: z.enum(DECLINE_REASONS).nullable().optional(),
    note: text(1000).default(""),
  })
  .refine((v) => v.status !== "declined" || v.declineReason, {
    message: "Pick why they declined",
    path: ["declineReason"],
  })
  .refine((v) => v.status === "declined" || !v.declineReason, {
    message: "A decline reason only goes with a decline",
    path: ["declineReason"],
  });
export type StatusInput = z.output<typeof statusSchema>;

export const submissionIdSchema = z.object({ submissionId: id });

export const offerSchema = z
  .object({
    submissionId: id,
    amount: money,
    factorRate: factor,
    payment: optMoney.default(null),
    frequency: frequency.nullable().optional(),
    termDays: optInt("Term", 1, 3650).default(null),
    positionNo: optInt("Position", 1, 20).default(null),
    fees: optMoney.default(null),
    receivedOn: isoDate.optional(),
    note: text(1000).default(""),
  })
  .refine((v) => v.payment === null || v.frequency, {
    message: "Say how often the remittance is debited",
    path: ["frequency"],
  })
  .refine((v) => v.payment === null || v.payment <= Math.round(v.amount * v.factorRate), {
    message: "One remittance can't be more than the whole payback",
    path: ["payment"],
  });
export type OfferInput = z.output<typeof offerSchema>;

export const offerIdSchema = z.object({ offerId: id });
export const offerStatusSchema = z.object({
  offerId: id,
  status: z.enum(OFFER_STATUSES).refine((s) => s !== "accepted", "Use Accept to accept an offer"),
});
