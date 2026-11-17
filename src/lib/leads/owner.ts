import type { Db } from "../db";
import { UserError } from "../data/mutations";
import { matchableEmail } from "../mca/matchEmail";
import { stageDef, type StageKey } from "../mca/stages";
import { firstName, tidy } from "../mca/templates";

/**
 * The cross-rep duplicate block (S1-3). Row security hides another rep's merchants from `findDuplicates`, so the
 * owner is asked for through lead_owner (a definer function that answers with the owner, the bucket and the last
 * touch, nothing more). A rep is refused in words; a manager is not refused here — they see every row and get the
 * ordinary duplicate outcome from the caller.
 */

export interface LeadOwner {
  client_id: string;
  owner_id: string;
  owner_name: string;
  owner_email: string;
  business_name: string;
  bucket_name: string | null;
  stage: StageKey;
  last_touch_at: string | null;
  matched_on: "phone" | "email";
}

/** Thrown when another rep owns the merchant. Carries the merchant so a loop can mark its row and move on. */
export class OwnedElsewhereError extends UserError {
  constructor(
    message: string,
    readonly owner: LeadOwner,
  ) {
    super(message);
  }
}

export async function lookupLeadOwner(
  q: Db,
  input: { phone?: string; email?: string },
): Promise<LeadOwner | null> {
  const email = matchableEmail(input.email);
  if (!input.phone?.trim() && !email) return null;
  const { rows } = await q.query<LeadOwner>("select * from lead_owner($1, $2)", [
    input.phone ?? "",
    email,
  ]);
  return rows[0] ?? null;
}

/** "today", "yesterday", "3 days ago"; "never" when nothing was ever logged. */
export function touchedAgo(lastTouchAt: string | null, now = new Date()): string {
  if (!lastTouchAt) return "never";
  const days = Math.max(
    0,
    Math.floor((now.getTime() - new Date(lastTouchAt).getTime()) / 86_400_000),
  );
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function ownerFirstName(o: Pick<LeadOwner, "owner_name" | "owner_email">): string {
  return tidy(firstName(o.owner_name)) || o.owner_email.split("@")[0] || "another rep";
}

/** "Already in the system: Mike's lead, in Missing statements, touched 3 days ago" */
export function ownedElsewhereMessage(o: LeadOwner, now = new Date()): string {
  const place = o.bucket_name ?? stageDef(o.stage).label;
  return `Already in the system: ${ownerFirstName(o)}'s lead, in ${place}, touched ${touchedAgo(o.last_touch_at, now)}`;
}

/**
 * Refuse a rep who is about to add a merchant another rep owns. Call it after the caller's own (row-security
 * scoped) duplicate check came back empty. A manager is allowed through.
 */
export async function refuseAnotherReps(
  q: Db,
  input: { phone?: string; email?: string },
  now = new Date(),
): Promise<void> {
  const owner = await lookupLeadOwner(q, input);
  if (!owner) return;
  const me = (
    await q.query<{ id: string | null; manager: boolean }>(
      "select app.current_user_id() as id, app.can_see_all() as manager",
    )
  ).rows[0];
  if (!me || me.manager || owner.owner_id === me.id) return;
  throw new OwnedElsewhereError(ownedElsewhereMessage(owner, now), owner);
}
