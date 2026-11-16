/**
 * The once-only ledger behind every job that sends: a (user, kind, date, ref) row is claimed BEFORE the send inside
 * the transaction that sends, so two overlapping runs cannot both send and a failed send rolls the claim back. The
 * reminder jobs in this folder write it directly; jobs elsewhere (the month-end close) come through here, so the
 * table is named in src/lib/system only.
 */
import type { Db } from "../db";

export type ClaimKind = "digest" | "call" | "new_lead" | "weekly" | "reply" | "close";

export interface Claim {
  userId: string;
  kind: ClaimKind;
  /** The local day (or period) the claim is for, YYYY-MM-DD. */
  forDate: string;
  ref?: string;
}

/** True when this run owns the send; false when another run already claimed it. */
export async function claimOnce(q: Db, c: Claim): Promise<boolean> {
  const r = await q.query(
    "insert into reminders_sent (user_id, kind, for_date, ref) values ($1, $2, $3::date, $4) on conflict do nothing",
    [c.userId, c.kind, c.forDate, c.ref ?? ""],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The provider's id for the send that the claim covers. */
export async function stampClaim(q: Db, c: Claim, providerId: string): Promise<void> {
  await q.query(
    "update reminders_sent set provider_id = $5 where user_id = $1 and kind = $2 and for_date = $3::date and ref = $4",
    [c.userId, c.kind, c.forDate, c.ref ?? "", providerId],
  );
}

/** Whether a claim exists at all (any run), for "who still needs this" queries. */
export async function claimed(q: Db, c: Claim): Promise<boolean> {
  const r = await q.query(
    "select 1 from reminders_sent where user_id = $1 and kind = $2 and for_date = $3::date and ref = $4",
    [c.userId, c.kind, c.forDate, c.ref ?? ""],
  );
  return (r.rowCount ?? 0) > 0;
}
