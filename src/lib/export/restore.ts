import type { Db } from "../db";
import { BACKUP_TABLES, BACKUP_VERSION, type Backup } from "./backup";

export class RestoreError extends Error {}

/** The order rows go back in: a merchant before what hangs off him, and the trash flags LAST — a trashed merchant's
 * rows can't be inserted once the trash flag exists (that is the point of the flag). */
const RESTORE_ORDER = [
  ...BACKUP_TABLES.filter((t) => t !== "trashed_clients"),
  "trashed_clients",
] as const;

/** Throws RestoreError with a sentence for a person if this is not a backup this version can read. */
export function checkBackup(file: unknown): Backup {
  const b = file as Partial<Backup> | null;
  if (!b || typeof b !== "object" || b.app !== "isaac" || typeof b.tables !== "object" || !b.tables)
    throw new RestoreError("That file is not an Isaac backup");
  if (b.version !== BACKUP_VERSION)
    throw new RestoreError(
      `That backup is version ${String(b.version)}; this app reads version ${BACKUP_VERSION}`,
    );
  for (const name of BACKUP_TABLES) {
    if (!Array.isArray(b.tables[name]))
      throw new RestoreError(`The backup is missing its "${name}" list`);
  }
  return b as Backup;
}

/**
 * Puts a backup back into an EMPTY account. Run with the database owner's connection (the CLI does): every row is
 * written under `targetUserId`, whatever user it came from. Ids are kept, so restoring on top of the same data (or
 * into a database that still holds the originals) is refused instead of half-done. All or nothing: the caller wraps
 * this in a transaction.
 */
export async function restoreBackup(
  q: Db,
  file: unknown,
  targetUserId: string,
): Promise<Record<string, number>> {
  const backup = checkBackup(file);
  const user = await q.query<{ id: string }>("select id from app_users where id = $1", [
    targetUserId,
  ]);
  if (user.rowCount === 0) throw new RestoreError("That account does not exist");
  const has = await q.query<{ n: number }>(
    "select (select count(*) from clients where user_id = $1)::int as n",
    [targetUserId],
  );
  if ((has.rows[0]?.n ?? 0) > 0)
    throw new RestoreError("That account already has merchants — restore into an empty account");
  const clash = await q.query<{ n: number }>(
    "select count(*)::int as n from clients where id = any($1::uuid[])",
    [(backup.tables.clients ?? []).map((r) => String(r.id))],
  );
  if ((clash.rows[0]?.n ?? 0) > 0)
    throw new RestoreError(
      "Some of these merchants already exist in this database under another account — restore into a fresh database",
    );

  const restored: Record<string, number> = {};
  for (const name of RESTORE_ORDER) {
    const rows = (backup.tables[name] ?? []).map((r) => ({ ...r, user_id: targetUserId }));
    const { rows: out } = await q.query<{ n: number }>(
      "select app.restore_rows($1, $2::jsonb) as n",
      [name, JSON.stringify(rows)],
    );
    restored[name] = out[0]?.n ?? 0;
  }
  // The expected counts come from the file itself: if a row was dropped on the way, say so now.
  for (const name of BACKUP_TABLES) {
    if (restored[name] !== (backup.tables[name] ?? []).length)
      throw new RestoreError(
        `"${name}": restored ${restored[name]} of ${backup.tables[name]?.length} rows`,
      );
  }
  return restored;
}
