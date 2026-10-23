import type { Db } from "../db";
import { addNote, createClient } from "../data/mutations";
import { findDuplicates } from "../data/queries";
import type { UserContext } from "../data/types";
import { contactAllowed, type ContactStatus } from "../mca/contact";
import { toNewClient, type LeadInput } from "./schema";

export interface IntakeResult {
  status: "created" | "duplicate";
  clientId: string;
  /** Duplicate only: the existing merchant is marked do-not-contact, so nothing was scheduled. */
  doNotContact?: boolean;
}

const from = (lead: LeadInput) => (lead.source ? ` via ${lead.source}` : "");

/**
 * A new lead goes on Today as "call now" (due today). A merchant already in the CRM is NOT added twice: the
 * new submission becomes a note on the existing card and its follow-up moves to today — unless that merchant
 * is do-not-contact, in which case only the note is added. Trashed merchants count as gone.
 */
export async function ingestLead(q: Db, lead: LeadInput, ctx: UserContext): Promise<IntakeResult> {
  const input = toNewClient(lead, ctx.today);
  const [dupe] = await findDuplicates(q, { phone: input.phone, businessName: input.businessName });

  if (dupe) {
    const { rows } = await q.query<{ contact_status: ContactStatus }>(
      "select contact_status from clients where id = $1",
      [dupe.id],
    );
    const status = rows[0]?.contact_status ?? "ok";
    await addNote(q, {
      clientId: dupe.id,
      body: `Came in again${from(lead)}${lead.notes ? `: ${lead.notes}` : ""}`,
    });
    // A trashed match is a do-not-contact (or limited) merchant kept on file: note only, no follow-up.
    const blocked = dupe.trashed || !contactAllowed(status, "call").ok;
    if (!blocked)
      await q.query("select * from set_follow_up($1, $2, $3)", [
        dupe.id,
        ctx.today,
        "Came in again — call now",
      ]);
    return { status: "duplicate", clientId: dupe.id, ...(blocked ? { doNotContact: true } : {}) };
  }

  const card = await createClient(q, input, ctx);
  await q.query("select * from set_follow_up($1, $2, $3)", [
    card.id,
    ctx.today,
    "New lead — call now",
  ]);
  if (lead.notes)
    await addNote(q, { clientId: card.id, body: `Lead came in${from(lead)}: ${lead.notes}` });
  return { status: "created", clientId: card.id };
}
