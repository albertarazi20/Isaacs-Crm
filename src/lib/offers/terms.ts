/** A merchant offer's terms and their arithmetic. Browser-safe: the form previews with the same numbers the database stores. */
import { z } from "zod";
import { formatMoney } from "../money";

export const FREQUENCIES = ["daily", "weekly", "biweekly", "monthly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const FREQUENCY_WORDS: Record<
  Frequency,
  { label: string; payment: string; perYear: number }
> = {
  // daily means each business day (about 21.7 a month)
  daily: { label: "Daily", payment: "Daily payment", perYear: 260 },
  weekly: { label: "Weekly", payment: "Weekly payment", perYear: 52 },
  biweekly: { label: "Every two weeks", payment: "Payment every two weeks", perYear: 26 },
  monthly: { label: "Monthly", payment: "Monthly payment", perYear: 12 },
};

/** What the merchant uploads before accepting. */
export const OFFER_DOCS = [
  "drivers_license",
  "voided_check",
  "proof_of_ownership",
  "processing_statement",
  "tax_return",
  "lease_letter",
] as const;
export type OfferDoc = (typeof OFFER_DOCS)[number];

export const OFFER_DOC_WORDS: Record<OfferDoc, { label: string; hint: string }> = {
  drivers_license: {
    label: "Driver's license",
    hint: "A clear photo or scan of the owner's license, front side.",
  },
  voided_check: { label: "Voided check", hint: "A voided check for the business bank account." },
  proof_of_ownership: {
    label: "Proof of ownership",
    hint: "Articles of organization, a business license, or similar.",
  },
  processing_statement: {
    label: "Processing statement",
    hint: "Your latest card processing statement.",
  },
  tax_return: { label: "Tax return", hint: "The business's most recent tax return." },
  lease_letter: {
    label: "Landlord letter",
    hint: "A lease or a letter from your landlord for the business location.",
  },
};

/**
 * Exactly what the database computes: the payback rounded to the cent, each payment the payback split up and rounded
 * down, and the final payment carrying what is left, so the payments add up to the payback to the cent.
 */
export function computeTerms(t: { fundedCents: number; factorRate: number; payments: number }): {
  paybackCents: number;
  paymentCents: number;
  finalPaymentCents: number;
  costCents: number;
} {
  // the factor is three decimals at most: work in thousandths so 1.499 never becomes 1.4989999
  const paybackCents = Math.round((t.fundedCents * Math.round(t.factorRate * 1000)) / 1000);
  const paymentCents = t.payments > 0 ? Math.floor(paybackCents / t.payments) : 0;
  return {
    paybackCents,
    paymentCents,
    finalPaymentCents: finalPayment(paybackCents, paymentCents, t.payments),
    costCents: paybackCents - t.fundedCents,
  };
}

/** The last payment: the payback less all the others (a few cents more than the rest, or the same). */
export const finalPayment = (
  paybackCents: number,
  paymentCents: number,
  payments: number,
): number => (payments > 0 ? paybackCents - paymentCents * (payments - 1) : 0);

/** "about 6 months", "about 2 years": how long the payments run. */
export function termWords(frequency: Frequency, payments: number): string {
  const months = (payments / FREQUENCY_WORDS[frequency].perYear) * 12;
  if (months < 1.5) {
    const weeks = Math.max(1, Math.round((payments / FREQUENCY_WORDS[frequency].perYear) * 52));
    return `about ${weeks} week${weeks === 1 ? "" : "s"}`;
  }
  if (months < 24) {
    const m = Math.round(months);
    return `about ${m} month${m === 1 ? "" : "s"}`;
  }
  const y = Math.round((months / 12) * 2) / 2;
  return `about ${y} years`;
}

export const factorWords = (rate: number): string => rate.toFixed(3);

const money = z
  .string()
  .trim()
  .transform((s) => s.replace(/[$,\s]/g, ""))
  .pipe(
    z.string().regex(/^\d+(\.\d{1,2})?$/, "Write the amount in dollars, like 80850 or 80,850.00"),
  )
  .transform((s) => Math.round(Number(s) * 100))
  .pipe(
    z
      .number()
      .min(100_000, "An offer is at least $1,000")
      .max(1_000_000_000, "That is more than $10,000,000"),
  );

const factor = z
  .string()
  .trim()
  .regex(/^\d(\.\d{1,3})?$/, "Write the factor rate like 1.35 or 1.499")
  .transform(Number)
  .pipe(
    z.number().min(1, "A factor rate is at least 1.000").max(2.5, "That factor rate is over 2.500"),
  );

export const offerSchema = z.object({
  clientId: z.string().uuid(),
  approvalId: z.string().uuid().nullable().optional(),
  funded: money,
  factorRate: factor,
  frequency: z.enum(FREQUENCIES),
  payments: z.coerce
    .number()
    .int("The number of payments is a whole number")
    .min(1, "At least one payment")
    .max(1000, "At most 1,000 payments"),
  /** When the offer stops standing, as an instant (the form sends the rep's local date and time as ISO). */
  expiresAt: z
    .string()
    .datetime({ offset: true, message: "Pick when the offer runs out" })
    .refine(
      (s) => new Date(s).getTime() > Date.now() + 30 * 60_000,
      "The offer has to stand for at least half an hour",
    )
    .refine(
      (s) => new Date(s).getTime() < Date.now() + 60 * 86_400_000,
      "An offer can stand for 60 days at most",
    ),
  funder: z.string().trim().max(120).default(""),
  message: z.string().trim().max(600, "Keep the note under 600 characters").default(""),
  docs: z
    .array(z.enum(OFFER_DOCS))
    .max(OFFER_DOCS.length)
    .default(["drivers_license", "voided_check"]),
  /** Email it to the merchant now (else the rep copies the link and sends it their own way). */
  send: z.boolean().default(true),
});
export type OfferInput = z.output<typeof offerSchema>;

/** Days, hours and minutes left, "1d 23h", "4h 12m", "12m", or null when it has run out. */
export function timeLeft(expiresAt: string, nowMs: number): string | null {
  const ms = new Date(expiresAt).getTime() - nowMs;
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${Math.max(1, m)}m`;
}

/** Dollars, with cents only when there are some: $4,197.99, $80,850. */
export const exactMoney = (cents: number): string =>
  formatMoney(cents, { cents: Math.round(cents) % 100 !== 0 });

/** "Thursday, November 19 at 4:32 PM EST", where the merchant is. */
export function validThroughWords(iso: string, timezone: string): string {
  const d = new Date(iso);
  const fmt = (opts: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: timezone, ...opts }).format(d);
    } catch {
      return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", ...opts }).format(d);
    }
  };
  return `${fmt({ weekday: "long", month: "long", day: "numeric" })} at ${fmt({ hour: "numeric", minute: "2-digit", timeZoneName: "short" })}`;
}

/** A reference a merchant and a rep can both say on the phone: "SC-2026-1F3A9C" (the year it was made, six of its id). */
export const offerNumber = (id: string, createdAt: string): string =>
  `SC-${createdAt.slice(0, 4)}-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

/** "26 weekly payments", "26 payments every two weeks". */
export function paymentsWords(payments: number, frequency: Frequency): string {
  const n = `${payments} ${payments === 1 ? "payment" : "payments"}`;
  if (frequency === "biweekly") return `${n} every two weeks`;
  return `${payments} ${FREQUENCY_WORDS[frequency].label.toLowerCase()} ${payments === 1 ? "payment" : "payments"}`;
}

/** Money on a term sheet: always to the cent, $80,850.00. */
export const sheetMoney = (cents: number): string => formatMoney(cents, { cents: true });
