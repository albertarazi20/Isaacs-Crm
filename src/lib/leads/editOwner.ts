import type { Db } from "../db";
import { matchableEmail } from "../mca/matchEmail";
import { refuseAnotherReps } from "./owner";

const digits10 = (p: string | null | undefined) => (p ?? "").replace(/\D/g, "").slice(-10);

/**
 * Editing a card: the cross-rep block only applies to a phone or email that is actually being changed. A card that
 * already shares a number with another rep's card (a duplicate that pre-dates the block) stays editable for its
 * other fields, and the edited card never counts as "another rep's" for a value it already holds.
 */
export async function refuseAnotherRepsOnEdit(
  q: Db,
  clientId: string,
  fields: { phone?: string; email?: string },
): Promise<void> {
  if (!fields.phone && !fields.email) return;
  const { rows } = await q.query<{ phone: string | null; email: string | null }>(
    "select phone, email from clients where id = $1",
    [clientId],
  );
  const was = rows[0];
  const phone =
    fields.phone && digits10(fields.phone) !== digits10(was?.phone) ? fields.phone : undefined;
  const email =
    fields.email && matchableEmail(fields.email) !== matchableEmail(was?.email)
      ? fields.email
      : undefined;
  if (phone || email) await refuseAnotherReps(q, { phone, email });
}
