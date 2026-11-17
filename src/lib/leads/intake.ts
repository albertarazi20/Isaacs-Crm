import type { Db } from "../db";
import { addNote, createClient } from "../data/mutations";
import { nameKey } from "../data/nameKey";
import { findDuplicates } from "../data/queries";
import type { UserContext } from "../data/types";
import { contactAllowed, type ContactStatus } from "../mca/contact";
import { normalizeUS } from "../mca/phone";
import { toNewClient, type LeadInput } from "./schema";
import { refuseAnotherReps } from "./owner";
import { MAX_NEW_PER_DAY } from "./token";

export interface IntakeResult {
  status: "created" | "duplicate";
  clientId: string;
  /** Duplicate only: the existing merchant is marked do-not-contact, so nothing was scheduled. */
  doNotContact?: boolean;
  /** Duplicate only: what matched. */
  matchedOn?: "phone" | "name";
}

/** The token has already added its day's worth of new merchants. */
export class LeadCapError extends Error {
  constructor() {
    super(`This connection has already added ${MAX_NEW_PER_DAY} new merchants today`);
  }
}

const from = (lead: LeadInput) => (lead.source ? ` via ${lead.source}` : "");

/** What the second submission knew that the card doesn't: kept in the note, since the card is not rewritten. */
function details(lead: LeadInput): string {
  const bits = [
    lead.businessName ? `business ${lead.businessName}` : "",
    lead.contactName ? `contact ${lead.contactName}` : "",
    lead.phone ? `phone ${lead.phone}` : "",
    lead.email ? `email ${lead.email}` : "",
    lead.wantedAmount ? `wants ${lead.wantedAmount}` : "",
    lead.state ? `state ${lead.state}` : "",
  ].filter(Boolean);
  return bits.length ? ` (${bits.join(", ")})` : "";
}

/**
 * Two requests for the same lead at the same moment (a Zapier retry, a double-submit) must become ONE card.
 * Serialise on the phone and on the name for this user; always in the same order, so two requests can't wait
 * on each other. Released when the transaction ends.
 */
async function serialise(q: Db, phone: string, businessName: string): Promise<void> {
  const e164 = phone ? normalizeUS(phone) : null;
  const keys = [
    e164 ? `p:${e164.slice(2)}` : "",
    nameKey(businessName) ? `n:${nameKey(businessName)}` : "",
  ]
    .filter(Boolean)
    .sort();
  for (const k of keys)
    await q.query(
      "select pg_advisory_xact_lock(hashtextextended(app.current_user_id()::text || ':' || $1, 0))",
      [k],
    );
}

/**
 * A new lead goes on Today as "call now" (due today). A merchant already in the CRM is NOT added twice: the
 * new submission becomes a note on the existing card and its follow-up moves to today — unless that merchant
 * is do-not-contact, in which case only the note is added. Trashed merchants count as gone.
 * A name match only counts when one side has no phone: "Subway" with a different number is a different Subway.
 */
export async function ingestLead(
  q: Db,
  lead: LeadInput,
  ctx: UserContext,
  tokenId?: string,
): Promise<IntakeResult> {
  const input = toNewClient(lead, ctx.today);
  await serialise(q, input.phone, input.businessName);
  const matches = await findDuplicates(q, { phone: input.phone, businessName: input.businessName });
  const dupe = matches.find((m) => m.reason === "same phone" || !input.phone || !m.phone);

  if (dupe) {
    const { rows } = await q.query<{ contact_status: ContactStatus }>(
      "select contact_status from clients where id = $1",
      [dupe.id],
    );
    const status = rows[0]?.contact_status ?? "ok";
    // A trashed match is a do-not-contact (or limited) merchant kept on file: note only, no follow-up.
    const blocked = dupe.trashed || !contactAllowed(status, "call").ok;
    // Move the date BEFORE the note: both lock the merchant, and taking the locks in one order is what keeps
    // two concurrent submissions from deadlocking.
    if (!blocked)
      await q.query("select * from set_follow_up($1, $2, $3)", [
        dupe.id,
        ctx.today,
        "Came in again — call now",
      ]);
    await addNote(q, {
      clientId: dupe.id,
      body: `Came in again${from(lead)}${lead.notes ? `: ${lead.notes}` : ""}${details(lead)}`,
    });
    return {
      status: "duplicate",
      clientId: dupe.id,
      matchedOn: dupe.reason === "same phone" ? "phone" : "name",
      ...(blocked ? { doNotContact: true } : {}),
    };
  }

  // another rep's merchant is never added a second time under this rep (two reps would chase the same merchant)
  await refuseAnotherReps(q, { phone: input.phone, email: input.email });

  if (tokenId) {
    const { rows: slot } = await q.query<{ ok: boolean }>(
      "select lead_token_take_slot($1, $2) as ok",
      [tokenId, MAX_NEW_PER_DAY],
    );
    if (!slot[0]?.ok) throw new LeadCapError();
  }
  const card = await createClient(q, input, ctx);
  if (tokenId)
    await q.query(
      `insert into activities (user_id, client_id, kind, body)
       select c.user_id, c.id, 'system', 'Added by lead connection "' || t.label || '"'
         from clients c, lead_tokens t where c.id = $1 and t.id = $2`,
      [card.id, tokenId],
    );
  await q.query("select * from set_follow_up($1, $2, $3)", [
    card.id,
    ctx.today,
    "New lead — call now",
  ]);
  if (lead.notes)
    await addNote(q, { clientId: card.id, body: `Lead came in${from(lead)}: ${lead.notes}` });
  return { status: "created", clientId: card.id };
}
