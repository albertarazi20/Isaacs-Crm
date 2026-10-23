import "../zod-setup";
import { z } from "zod";
import { findSensitive } from "../data/sensitive";
import { isRealDate } from "../mca/dates";
import { parseFactor, parseMoney } from "../money";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date")
  .refine(isRealDate, "That isn't a real calendar date");
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Pick a date and time");
const id = z.string().uuid();
const frequency = z.enum(["daily", "weekly", "biweekly", "monthly"]);

/** Single-line text: no line breaks or control characters (see line() in src/lib/data/schemas.ts). */
const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u, "That field can't contain line breaks or control characters");

/** Free text. Refuses SSNs and card/account numbers — see src/lib/data/sensitive.ts. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .superRefine((v, ctx) => {
      const hit = findSensitive(v);
      if (hit) ctx.addIssue({ code: "custom", message: hit.message });
    });

const MONEY_MESSAGE = "Enter an amount like 50k or $75,000";

const money = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const cents = parseMoney(v);
  if (cents === null) {
    ctx.addIssue({ code: "custom", message: MONEY_MESSAGE });
    return z.NEVER;
  }
  return cents;
});

/** Blank means "none". */
const optMoney = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((v, ctx): number | null => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    const cents = parseMoney(v);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: MONEY_MESSAGE });
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

const wholeNumber = (what: string, min: number, max: number) =>
  z.union([z.string(), z.number()]).transform((v, ctx): number => {
    const n = typeof v === "number" ? v : v.trim() === "" ? Number.NaN : Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({
        code: "custom",
        message: `${what} must be a whole number from ${min} to ${max}`,
      });
      return z.NEVER;
    }
    return n;
  });

const optWholeNumber = (what: string, min: number, max: number) =>
  z.union([z.string(), z.number(), z.null(), z.undefined()]).transform((v, ctx): number | null => {
    if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      ctx.addIssue({
        code: "custom",
        message: `${what} must be a whole number from ${min} to ${max}`,
      });
      return z.NEVER;
    }
    return n;
  });

/**
 * The fields of the advance the Funding card can change. Every one is optional: the dialog sends only what Isaac
 * changed, so a dialog left open on another device can't write back stale values over a commission, a collected
 * figure or a promise recorded since. A missing key means "leave it alone"; null means "clear it". The database
 * validates again in update_funding_terms.
 */
export const termsUpdateSchema = z
  .object({
    fundedOn: isoDate,
    funderName: line(200),
    amount: money,
    factorRate: factor,
    payment: money,
    frequency,
    positionNo: wholeNumber("Position", 1, 20),
    termDays: optWholeNumber("Term", 1, 3650),
    /** Dollars. The dialog turns points into dollars before it sends. */
    commission: optMoney,
    commissionReceived: optMoney,
    commissionReceivedOn: isoDate.nullable().optional(),
    paidBackOverride: optMoney,
    lastPaymentOn: isoDate.nullable().optional(),
    promiseToPayAt: localDateTime.nullable().optional(),
    promiseAmount: optMoney,
    note: text(5000),
  })
  .partial()
  .extend({ fundingId: id });
export type TermsUpdateInput = z.output<typeof termsUpdateSchema>;

/** "Mark commission received" from the Earnings page: just the amount and the day. */
export const commissionReceivedSchema = z.object({
  fundingId: id,
  amount: money,
  receivedOn: isoDate,
});
export type CommissionReceivedInput = z.output<typeof commissionReceivedSchema>;
