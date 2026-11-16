import { z } from "zod";
import type { Db } from "../db";
import { createClient, stampClientTimezone, UserError } from "../data/mutations";
import { findDuplicates, userContext, type DuplicateMatch } from "../data/queries";
import { id, optMoney } from "../data/schemas";
import { stageDef } from "../mca/stages";
import { fileOneRow, PENDING_ROW_COLUMNS, sendWelcome, type PendingRow } from "../sheets/file";
import { refuseAnotherReps } from "./owner";

/**
 * The Lead Intake page's submit, apart from the session: a merchant row, the bucket, and the bucket's first
 * email on the spot (intake lane — never blocked by the cap). A phone already in the CRM is a duplicate, not a
 * second merchant. When the phone lookup found the lead on a Google Sheet, that row is filed (and marked).
 */

const line = (n: number) => z.string().trim().max(n);
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "That is not an email address");

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
  wantedAmount: optMoney.optional(),
  bucketId: id.nullable().default(null),
  /** When the phone lookup found the lead on a Google Sheet, file that row (it is then marked on the sheet side). */
  sheetRowId: id.nullable().default(null),
  source: line(100).default("Lead intake"),
});
export type IntakeInput = z.output<typeof intakeSchema>;

export interface IntakeOutcome {
  clientId: string;
  businessName: string;
  /** created: typed in; filed: from a sheet row; duplicate: already here, nothing made. A failure is thrown. */
  result: "created" | "filed" | "duplicate";
  welcomeSent: boolean;
  bucketName: string | null;
  /** Duplicate only: whose merchant it is and where it sits (its bucket, else its stage). */
  existing: { ownerName: string; place: string } | null;
}

const whereItSits = (m: DuplicateMatch) => ({
  ownerName: m.owner_name,
  place: m.bucket_name ?? stageDef(m.stage).label,
});

export async function intakeLead(
  q: Db,
  i: IntakeInput,
  appUrl: string,
  now = new Date(),
): Promise<IntakeOutcome> {
  const ctx = await userContext(q, now);
  const bucketName = i.bucketId
    ? ((await q.query<{ name: string }>("select name from buckets where id = $1", [i.bucketId]))
        .rows[0]?.name ?? null)
    : null;
  if (i.bucketId && !bucketName) throw new UserError("That bucket is gone");

  const contact = `${i.firstName} ${i.lastName}`.trim();

  if (i.sheetRowId) {
    const { rows } = await q.query<PendingRow>(
      `select app.current_user_id() as owner_id, ${PENDING_ROW_COLUMNS}
         from sheet_rows r join sheet_sources s on s.id = r.source_id where r.id = $1`,
      [i.sheetRowId],
    );
    const row = rows[0];
    if (!row) throw new UserError("That sheet row is gone");
    // what was typed wins; the sheet's own words fill whatever was left blank
    const business =
      i.businessName || row.business_name || contact || row.contact_name || "New lead";
    const filed = await fileOneRow(
      q,
      {
        ...row,
        business_name: business,
        contact_name: contact || row.contact_name,
        email: i.email || row.email,
        email2: i.email2 || row.email2,
        phone: i.phone,
        phone2: i.phone2 || row.phone2,
        industry: i.industry || row.industry,
        state: i.state || row.state,
      },
      appUrl,
      now,
      i.bucketId,
      { wantedAmountCents: i.wantedAmount, lookingFor: i.lookingFor },
    );
    if (filed.result === "duplicate")
      return {
        clientId: filed.clientId,
        businessName: filed.match.business_name,
        result: "duplicate",
        welcomeSent: false,
        bucketName,
        existing: whereItSits(filed.match),
      };
    return {
      clientId: filed.clientId,
      businessName: business,
      result: "filed",
      welcomeSent: filed.welcomeSent,
      bucketName,
      existing: null,
    };
  }

  const business = i.businessName || contact || "New lead";
  const existing = await findDuplicates(q, { phone: i.phone });
  if (existing[0]) {
    return {
      clientId: existing[0].id,
      businessName: existing[0].business_name,
      result: "duplicate",
      welcomeSent: false,
      bucketName,
      existing: whereItSits(existing[0]),
    };
  }
  // another rep's merchant is invisible to the check above: ask across the shop and refuse in words (S1-3)
  await refuseAnotherReps(q, { phone: i.phone, email: i.email }, now);
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
  await stampClientTimezone(q, card.id);
  // a new lead is a call to make now, not tomorrow: the same timer the lead connections give (S1-10)
  await q.query("select * from set_follow_up($1, $2, $3)", [
    card.id,
    ctx.today,
    "New lead — call now",
  ]);
  let welcomeSent = false;
  if (i.bucketId) {
    await q.query("select enroll_in_bucket($1, $2, 'moved')", [card.id, i.bucketId]);
    welcomeSent = await sendWelcome(q, card.id, i.bucketId, appUrl, now);
  }
  return {
    clientId: card.id,
    businessName: business,
    result: "created",
    welcomeSent,
    bucketName,
    existing: null,
  };
}
