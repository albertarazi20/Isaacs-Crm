import { z } from "zod";
import { newClientSchema } from "../data/schemas";
import { findSensitive } from "../data/sensitive";

/** Forms and Zapier send an empty field as null; that means "not given", never "refuse the lead". */
const str = (max: number) =>
  z.preprocess(
    (v) => (v === null ? undefined : v),
    z
      .union([z.string(), z.number()], { error: "must be text or a number" })
      .transform((v) => String(v).trim())
      .pipe(z.string().max(max, `Keep it under ${max} characters`))
      .optional(),
  );

/** One plain sentence about the first problem, naming the field when the problem is about one. */
export function describeLeadProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "That lead isn't valid";
  const field = issue.path[0];
  return typeof field === "string" ? `${field}: ${issue.message}` : issue.message;
}

/**
 * What a form or a lead vendor may send. Everything is optional except a way to reach the merchant.
 * `stage` and anything else is ignored on purpose: an outside caller can add a lead, nothing more.
 */
export const leadSchema = z
  .object({
    businessName: str(200).optional(),
    contactName: str(200).optional(),
    phone: str(40).optional(),
    email: str(200).optional(),
    wantedAmount: str(40).optional(),
    industry: str(100).optional(),
    state: str(40).optional(),
    source: str(100).optional(),
    notes: str(2000).optional(),
  })
  // "N/A", "none", "-" are not phone numbers: kept out, so the lead is judged on what it really gave.
  .transform((v) => ({
    ...v,
    phone: (v.phone ?? "").replace(/\D/g, "").length >= 7 ? v.phone : undefined,
  }))
  .superRefine((v, ctx) => {
    if (!v.phone && !v.email)
      ctx.addIssue({ code: "custom", message: "Include a phone number or an email" });
    if (!v.businessName && !v.contactName)
      ctx.addIssue({ code: "custom", message: "Include a business name or a contact name" });
    const hit = v.notes ? findSensitive(v.notes) : null;
    if (hit) ctx.addIssue({ code: "custom", message: hit.message });
  });

export type LeadInput = z.output<typeof leadSchema>;

/** The lead as a new-client record: the business name falls back to the contact's, a missing source is "Lead intake". */
export function toNewClient(lead: LeadInput, today: string) {
  return newClientSchema.parse({
    businessName: lead.businessName || lead.contactName,
    contactName: lead.contactName ?? "",
    phone: lead.phone ?? "",
    email: lead.email ?? "",
    industry: lead.industry ?? "",
    state: lead.state ?? "",
    source: lead.source || "Lead intake",
    wantedAmount: lead.wantedAmount || undefined,
    stage: "name_in",
    followUpOn: today,
  });
}
