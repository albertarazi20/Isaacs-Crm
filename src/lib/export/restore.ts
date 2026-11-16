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
    throw new RestoreError("That file is not a Selective CRM backup");
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
  // Every table has to be empty for this account, not just the merchants: a funder or snippet already there would
  // collide halfway through the work.
  const used = await q.query<{ name: string }>(
    `select name from (values
       ('clients', (select count(*) from clients where user_id = $1)),
       ('trashed_clients', (select count(*) from trashed_clients where user_id = $1)),
       ('client_asks', (select count(*) from client_asks where user_id = $1)),
       ('positions', (select count(*) from positions where user_id = $1)),
       ('competing_offers', (select count(*) from competing_offers where user_id = $1)),
       ('fundings', (select count(*) from fundings where user_id = $1)),
       ('stips', (select count(*) from stips where user_id = $1)),
       ('funders', (select count(*) from funders where user_id = $1)),
       ('submissions', (select count(*) from submissions where user_id = $1)),
       ('offers', (select count(*) from offers where user_id = $1)),
       ('timers', (select count(*) from timers where user_id = $1)),
       ('activities', (select count(*) from activities where user_id = $1)),
       ('snippets', (select count(*) from snippets where user_id = $1))
     ) v(name, n) where n > 0`,
    [targetUserId],
  );
  if (used.rows.some((r) => r.name === "clients"))
    throw new RestoreError("That account already has merchants — restore into an empty account");
  if (used.rows.length > 0)
    throw new RestoreError(
      `That account already has ${used.rows.map((r) => r.name).join(", ")} — restore into an empty account`,
    );
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
  // His settings come back too. The time zone matters most: it decides what "today" and "tomorrow" mean in the database.
  const p = backup.profile;
  if (p) {
    await q.query(
      `update app_users set
          timezone = coalesce($2::text, timezone),
          signature = coalesce($3::text, signature),
          application_link = coalesce($4::text, application_link),
          digest_enabled = coalesce($5::boolean, digest_enabled),
          digest_hour = coalesce($6::int, digest_hour)
        where id = $1`,
      [
        targetUserId,
        typeof p.timezone === "string" ? p.timezone : null,
        typeof p.signature === "string" ? p.signature : null,
        typeof p.application_link === "string" ? p.application_link : null,
        typeof p.digest_enabled === "boolean" ? p.digest_enabled : null,
        typeof p.digest_hour === "number" ? p.digest_hour : null,
      ],
    );
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
