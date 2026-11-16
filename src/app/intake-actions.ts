"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth/server";
import { toActionError } from "@/lib/data/errors";
import { createClient, UserError } from "@/lib/data/mutations";
import { findDuplicates, userContext } from "@/lib/data/queries";
import { id } from "@/lib/data/schemas";
import type { ActionResult } from "@/lib/data/types";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { parseMoney } from "@/lib/money";
import { fileOneRow, sendWelcome } from "@/lib/sheets/file";

const line = (n: number) => z.string().trim().max(n);
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "That is not an email address");
const optMoney = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined || v === "" ? null : parseMoney(v)));

export const intakeSchema = z.object({
  firstName: line(80).default(""),
  lastName: line(80).default(""),
  businessName: line(200).default(""),
  phone: line(40).min(7, "A phone number is required"),
  email: email.default(""),
  phone2: line(40).default(""),
  email2: email.default(""),
  industry: line(100).default(""),
  state: line(40).default(""),
  lookingFor: line(1000).default(""),
  wantedAmount: optMoney,
  bucketId: id.nullable().default(null),
  /** When the phone lookup found the lead on a Google Sheet, file that row (it is then marked on the sheet side). */
  sheetRowId: id.nullable().default(null),
  source: line(100).default("Lead intake"),
});

export interface IntakeOutcome {
  clientId: string | null;
  businessName: string;
  result: "created" | "filed" | "duplicate";
  welcomeSent: boolean;
  bucketName: string | null;
}

/**
 * The intake form's submit: a merchant row, the bucket, and the bucket's first email on the spot (intake lane —
 * never blocked by the cap). A phone already in the CRM is a duplicate, not a second merchant.
 */
export async function intakeLeadAction(input: unknown): Promise<ActionResult<IntakeOutcome>> {
  const session = await requireSession();
  try {
    const i = intakeSchema.parse(input);
    const appUrl = env().APP_URL;
    const data = await db.withUser(session.userId, async (q): Promise<IntakeOutcome> => {
      const ctx = await userContext(q);
      const bucketName = i.bucketId
        ? ((await q.query<{ name: string }>("select name from buckets where id = $1", [i.bucketId]))
            .rows[0]?.name ?? null)
        : null;
      if (i.bucketId && !bucketName) throw new UserError("That bucket is gone");

      const contact = `${i.firstName} ${i.lastName}`.trim();
      const business = i.businessName || contact || "New lead";

      if (i.sheetRowId) {
        const { rows } = await q.query(
          `select r.id, r.source_id, $2::uuid as owner_id, s.target_bucket_id, s.name as source_name, r.business_name, r.contact_name,
                  r.email, r.phone, r.phone2, r.industry, r.state, r.monthly_revenue_cents, r.wanted, r.notes
             from sheet_rows r join sheet_sources s on s.id = r.source_id where r.id = $1`,
          [i.sheetRowId, session.userId],
        );
        const row = rows[0];
        if (!row) throw new UserError("That sheet row is gone");
        const filed = await fileOneRow(
          q,
          {
            ...row,
            business_name: business,
            contact_name: contact || row.contact_name,
            email: i.email || row.email,
            phone: i.phone,
            phone2: i.phone2 || row.phone2,
            industry: i.industry || row.industry,
            state: i.state || row.state,
            wanted: i.lookingFor || row.wanted,
          },
          appUrl,
          new Date(),
          i.bucketId,
        );
        const dup = await findDuplicates(q, { phone: i.phone });
        const clientId = dup[0]?.id ?? null;
        if (clientId) {
          await q.query(
            "update clients set phone2 = coalesce(nullif($2, ''), phone2), email2 = coalesce(nullif($3, ''), email2), looking_for = coalesce(nullif($4, ''), looking_for) where id = $1",
            [clientId, i.phone2, i.email2, i.lookingFor],
          );
        }
        return {
          clientId,
          businessName: business,
          result: filed === "filed" ? "filed" : "duplicate",
          welcomeSent: filed === "filed" && i.bucketId !== null,
          bucketName,
        };
      }

      const existing = await findDuplicates(q, { phone: i.phone });
      if (existing[0]) {
        return {
          clientId: existing[0].id,
          businessName: existing[0].business_name,
          result: "duplicate",
          welcomeSent: false,
          bucketName,
        };
      }
      const card = await createClient(
        q,
        {
          businessName: business,
          contactName: contact,
          phone: i.phone,
          email: i.email,
          industry: i.industry,
          state: i.state,
          source: i.source,
          stage: "name_in",
          wantedAmount: i.wantedAmount ?? undefined,
        },
        ctx,
      );
      await q.query(
        "update clients set phone2 = $2, email2 = $3, looking_for = $4, lead_source_kind = 'own_form' where id = $1",
        [card.id, i.phone2, i.email2, i.lookingFor],
      );
      let welcomeSent = false;
      if (i.bucketId) {
        await q.query("select enroll_in_bucket($1, $2, 'moved')", [card.id, i.bucketId]);
        welcomeSent = await sendWelcome(q, card.id, i.bucketId, appUrl);
      }
      return {
        clientId: card.id,
        businessName: business,
        result: "created",
        welcomeSent,
        bucketName,
      };
    });
    revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: toActionError(e) };
  }
}
