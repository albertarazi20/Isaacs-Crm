/**
 * The follow-up system's finish line (docs/FOLLOW-UP-SYSTEM.md): a rep hands a merchant off once the file is in.
 * Thin wrappers over hand_off / undo_hand_off (db/migrations/0540): run them under db.withUser, so the database
 * decides whose merchant it is.
 */
import { UserError } from "../data/mutations";
import type { Db } from "../db";

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const code = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

/** Marks the merchant as brought in and ends the chase. Returns when (the first time, if it was already done). */
export async function handOff(q: Db, clientId: string): Promise<string> {
  try {
    const { rows } = await q.query<{ at: Date | string | null }>("select hand_off($1) as at", [
      clientId,
    ]);
    const at = rows[0]?.at;
    if (!at) throw new UserError("That merchant could not be handed off — try again");
    return iso(at);
  } catch (e) {
    if (code(e) === "P0002")
      throw new UserError("That merchant is not on your list, so you cannot hand it off");
    if (code(e) === "22023")
      throw new UserError("That merchant is in the trash — restore it before handing it off");
    throw e;
  }
}

export interface UndoneHandOff {
  /** The hand-off time that was cleared, or null when the merchant was not handed off. */
  undone: string | null;
  /** The bucket the merchant went back into, at the step where the chase stopped; null when there was none to
   * re-open (the bucket is gone, or the chase closed meanwhile), so a follow-up for tomorrow was set instead. */
  bucket: string | null;
}

/**
 * Takes a hand-off back: the merchant goes back into the bucket the hand-off took them out of, at the same next step
 * (0546). With no bucket to go back to, they return to the rep's list with a follow-up for tomorrow.
 */
export async function undoHandOff(q: Db, clientId: string): Promise<UndoneHandOff> {
  try {
    const { rows } = await q.query<{ at: Date | string | null }>("select undo_hand_off($1) as at", [
      clientId,
    ]);
    const at = rows[0]?.at;
    if (!at) return { undone: null, bucket: null };
    const live = await q.query<{ name: string }>(
      `select b.name from enrollments e join buckets b on b.id = e.bucket_id
        where e.client_id = $1 and e.stopped_at is null
        order by e.entered_at desc limit 1`,
      [clientId],
    );
    return { undone: iso(at), bucket: live.rows[0]?.name ?? null };
  } catch (e) {
    if (code(e) === "P0002")
      throw new UserError("That merchant is not on your list, so you cannot undo its hand-off");
    if (code(e) === "22023")
      throw new UserError("That merchant is in the trash — restore it before undoing the hand-off");
    throw e;
  }
}
