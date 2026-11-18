import type { Db } from "../db";

/** Bump when the shape changes, so a restore can tell which file it is reading. */
export const BACKUP_VERSION = 1;

/**
 * The merchant columns that are bearer tokens: a backup never carries them. Each opens something to anyone holding it
 * (his documents and upload page, his application), so a restore makes new ones.
 */
export const CLIENT_SECRET_COLUMNS = ["upload_token", "application_token"] as const;

/**
 * Kept in the backup and put back on restore, on purpose. Every email already sent carries /u/<token> and a one-click
 * List-Unsubscribe link; a restore that replaced the token would kill those links (CAN-SPAM, Gmail one-click). The token
 * can do one thing: unsubscribe that one merchant. Nothing is read, opened or sent with it.
 */
export const CLIENT_KEPT_TOKEN_COLUMN = "unsubscribe_token";

/**
 * Every table of Isaac's own data, in the order a restore must insert them (a merchant before the things that hang off
 * him; `restore.ts` puts the trash flags last). Row-level security returns only the signed-in user's rows, and nothing
 * here is built from input.
 *
 * ONE statement reads them all. Each statement in a read-committed transaction gets its own snapshot, so seven
 * separate selects could catch a merchant created in between: his notes in the file, him not, and a restore that dies
 * on a foreign key the day it is needed (review-4 C-2). One statement is one snapshot.
 *
 * Left out ON PURPOSE: Gmail tokens, lead-token fingerprints, session state, the reminder ledger, and each merchant's
 * CLIENT_SECRET_COLUMNS (links that open his upload page or his application to anyone holding them; a restore gets
 * new ones from the column defaults). Each merchant's unsubscribe_token IS kept (CLIENT_KEPT_TOKEN_COLUMN): it can only
 * unsubscribe him, and links in emails already sent must keep working. A backup file is a document that gets emailed
 * and left in Downloads; it must hold nothing that can open or send on an account.
 *
 * What a backup covers: the tables in BACKUP_TABLES plus the user's profile. It does NOT cover anything added since
 * version 1 (documents and their files, applications, follow-up enrolments, inbound emails and reply tags, the outbox,
 * merchant offers, alerts, assistant conversations, link opens); `app.restore_rows` only accepts the tables above.
 */
export const BACKUP_TABLES: readonly string[] = [
  "clients",
  "trashed_clients",
  "client_asks",
  "stips",
  "timers",
  "activities",
  "snippets",
];

const BACKUP_SQL = `
select jsonb_build_object(
  'profile', (select jsonb_build_object('email', email, 'name', name, 'timezone', timezone,
                                        'digest_enabled', digest_enabled, 'digest_hour', digest_hour,
                                        'notify_email', notify_email, 'signature', signature,
                                        'application_link', application_link)
                from app_users where id = app.current_user_id()),
  'clients', (select coalesce(jsonb_agg(to_jsonb(t) - 'upload_token' - 'application_token' order by t.created_at, t.id), '[]') from clients t),
  'trashed_clients', (select coalesce(jsonb_agg(to_jsonb(t) order by t.trashed_at, t.client_id), '[]') from trashed_clients t),
  'client_asks', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from client_asks t),
  'stips', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from stips t),
  'timers', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from timers t),
  'activities', (select coalesce(jsonb_agg(to_jsonb(t) order by t.occurred_at, t.id), '[]') from activities t),
  'snippets', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]') from snippets t)
) as j`;

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
  const { rows } = await q.query<{ j: Record<string, unknown> }>(BACKUP_SQL);
  const j = rows[0]?.j ?? {};
  const tables: Backup["tables"] = {};
  const counts: Backup["counts"] = {};
  for (const name of BACKUP_TABLES) {
    const list = (j[name] ?? []) as Record<string, unknown>[];
    tables[name] = list;
    counts[name] = list.length;
  }
  return {
    app: "isaac",
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    profile: (j.profile as Record<string, unknown> | null | undefined) ?? null,
    counts,
    tables,
  };
}
