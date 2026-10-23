import type { Db } from "../db";

/** Bump when the shape changes, so a restore can tell which file it is reading. */
export const BACKUP_VERSION = 1;

/**
 * Every table of Isaac's own data, in the order a restore must insert them (a merchant before the things that hang off
 * him). Fixed literal queries on purpose: row-level security returns only the signed-in user's rows, and nothing here
 * is built from input.
 *
 * Left out ON PURPOSE: Gmail tokens, lead-token fingerprints, session state, the reminder ledger. A backup file is a
 * document that gets emailed and left in Downloads; it must hold nothing that can act on an account.
 */
const TABLES: readonly (readonly [string, string])[] = [
  ["clients", "select to_jsonb(t) as j from clients t order by t.created_at, t.id"],
  [
    "trashed_clients",
    "select to_jsonb(t) as j from trashed_clients t order by t.trashed_at, t.client_id",
  ],
  ["client_asks", "select to_jsonb(t) as j from client_asks t order by t.created_at, t.id"],
  ["positions", "select to_jsonb(t) as j from positions t order by t.created_at, t.id"],
  [
    "competing_offers",
    "select to_jsonb(t) as j from competing_offers t order by t.created_at, t.id",
  ],
  ["fundings", "select to_jsonb(t) as j from fundings t order by t.funded_on, t.created_at, t.id"],
  ["stips", "select to_jsonb(t) as j from stips t order by t.created_at, t.id"],
  ["funders", "select to_jsonb(t) as j from funders t order by t.created_at, t.id"],
  ["submissions", "select to_jsonb(t) as j from submissions t order by t.created_at, t.id"],
  ["offers", "select to_jsonb(t) as j from offers t order by t.created_at, t.id"],
  ["timers", "select to_jsonb(t) as j from timers t order by t.created_at, t.id"],
  ["activities", "select to_jsonb(t) as j from activities t order by t.occurred_at, t.id"],
  ["snippets", "select to_jsonb(t) as j from snippets t order by t.created_at, t.id"],
];

export const BACKUP_TABLES: readonly string[] = TABLES.map(([name]) => name);

export interface Backup {
  app: "isaac";
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  /** The signed-in user's own settings (never their sign-in or Gmail details). */
  profile: Record<string, unknown> | null;
  counts: Record<string, number>;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function buildBackup(q: Db, now: Date = new Date()): Promise<Backup> {
  const profile = (
    await q.query<{ j: Record<string, unknown> }>(
      `select jsonb_build_object('email', email, 'name', name, 'timezone', timezone,
                                 'digest_enabled', digest_enabled, 'digest_hour', digest_hour,
                                 'notify_email', notify_email, 'signature', signature,
                                 'application_link', application_link) as j
         from app_users where id = app.current_user_id()`,
    )
  ).rows[0]?.j;
  const tables: Backup["tables"] = {};
  const counts: Backup["counts"] = {};
  for (const [name, sql] of TABLES) {
    const rows = (await q.query<{ j: Record<string, unknown> }>(sql)).rows.map((r) => r.j);
    tables[name] = rows;
    counts[name] = rows.length;
  }
  return {
    app: "isaac",
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    profile: profile ?? null,
    counts,
    tables,
  };
}
